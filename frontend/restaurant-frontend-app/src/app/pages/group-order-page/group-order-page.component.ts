import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  EMPTY,
  Subscription,
  catchError,
  exhaustMap,
  forkJoin,
  interval,
  map,
  of,
  switchMap,
} from 'rxjs';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
import { GroupReservationStatus } from '@app/models/group-orders/group-status.model';
import { Participant } from '@app/models/group-orders/participant.model';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { GroupOrdersService } from '@app/services/group-orders/group-orders.service';
import { ToastService } from '@app/services/toast/toast.service';
import { consolidatePreOrder } from '@app/shared/helpers/consolidate-pre-order';
import { ModalComponent } from '@app/shared/custom-components/modal/modal.component';
import { GroupOrderLoadState } from './group-order-load-state.model';

/** Background sync interval while the group is Open (level 3). */
export const GROUP_ORDER_SYNC_MS = 15_000;

const STATUS_LABELS: Record<GroupReservationStatus, string> = {
  Open: 'Collecting pre-orders',
  Submitted: 'Sent to Restaurant',
  Closed: 'Closed',
};

@Component({
  selector: 'app-group-order-page',
  imports: [ParticipantCardComponent, ModalComponent, CurrencyPipe, DatePipe, RouterLink],
  templateUrl: './group-order-page.component.html',
  styleUrl: './group-order-page.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GroupOrderPageComponent {
  private readonly service = inject(GroupOrdersService);
  private readonly toast = inject(ToastService);
  private readonly reservationId =
    inject(ActivatedRoute).snapshot.paramMap.get('reservationId') ?? '';

  private loadSubscription?: Subscription;
  private syncSubscription?: Subscription;

  // ---------- state ----------
  readonly loadState = signal<GroupOrderLoadState>('loading');
  readonly invite = signal<GuestInvite | null>(null);
  readonly participants = signal<Participant[]>([]);
  readonly ownerSessionId = signal<string | null>(null);
  readonly status = signal<GroupReservationStatus>('Open');

  readonly confirmSubmitOpen = signal(false);
  readonly submitting = signal(false);

  readonly removeTarget = signal<Participant | null>(null);
  readonly removing = signal(false);

  readonly lastUpdated = signal<Date | null>(null);
  readonly refreshing = signal(false);
  readonly refreshFailed = signal(false);

  // ---------- derived ----------
  readonly consolidated = computed(() => consolidatePreOrder(this.participants()));
  /** Only submitted carts go to the restaurant, so this is NOT the `total` from the API. */
  readonly grandTotal = computed(() => this.consolidated().total);

  readonly isOpen = computed(() => this.status() === 'Open');
  readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);

  readonly pendingCount = computed(
    () => this.participants().filter((person) => !person.isSubmitted).length
  );
  readonly pendingMessage = computed(() => {
    const count = this.pendingCount();
    return count === 1
      ? "1 participant hasn't submitted their cart yet — their dishes won't be included in the order"
      : `${count} participants haven't submitted their cart yet — their dishes won't be included in the order`;
  });

  readonly hasNoDishes = computed(() =>
    this.participants().every((person) => person.items.length === 0)
  );
  readonly canSubmit = computed(
    () => this.isOpen() && this.consolidated().items.length > 0 && !this.submitting()
  );

  readonly guestsLabel = computed(
    () => `${this.participants().length} of ${this.invite()?.MaxGuestCount ?? 0} guests`
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.loadSubscription?.unsubscribe();
      this.stopSync();
    });
    this.load();
  }

  /** Full load with a page loader. «Try again» calls it again — the sync timer is never duplicated. */
  load(): void {
    this.loadSubscription?.unsubscribe();
    this.stopSync();
    this.loadState.set('loading');

    this.loadSubscription = this.service
      .getGroupInvite$(this.reservationId)
      .pipe(
        switchMap((invite) =>
          forkJoin({
            sessions: this.service.getSessions$(invite.GroupReservationId),
            ownerSessionId: this.service
              .getOwnerSessionId$(this.reservationId)
              .pipe(catchError(() => of(null))),
            status: this.service.getStatus$(invite.GroupReservationId),
          }).pipe(map((data) => ({ invite, ...data })))
        )
      )
      .subscribe({
        next: ({ invite, sessions, ownerSessionId, status }) => {
          this.invite.set(invite);
          this.participants.set(sessions.participants);
          this.ownerSessionId.set(ownerSessionId);
          this.status.set(status.status);
          this.markUpdated();
          this.loadState.set('ready');
          this.startSync();
        },
        error: (error: unknown) => {
          this.loadState.set(
            error instanceof HttpErrorResponse && error.status === 404 ? 'not-found' : 'error'
          );
        },
      });
  }

  /** «Refresh» button: sync right now (skipped while another refresh is still running). */
  refresh(): void {
    if (this.refreshing() || !this.isOpen()) return;
    this.refreshing.set(true);
    this.fetchLatest().subscribe();
  }

  isMe(person: Participant): boolean {
    return person.id === this.ownerSessionId();
  }

  canRemove(person: Participant): boolean {
    return person.type === 'Guest' && this.isOpen();
  }

  // ---------- submit ----------
  openSubmitDialog(): void {
    if (this.canSubmit()) this.confirmSubmitOpen.set(true);
  }

  closeSubmitDialog(): void {
    if (!this.submitting()) this.confirmSubmitOpen.set(false);
  }

  confirmSubmit(): void {
    const groupId = this.invite()?.GroupReservationId;
    if (this.submitting() || !groupId) return;
    this.submitting.set(true);

    this.service.submit$(groupId, this.reservationId).subscribe({
      next: () => {
        this.submitting.set(false);
        this.confirmSubmitOpen.set(false);
        this.status.set('Submitted');
        this.stopSync();
        this.toast.success('Pre-order sent to the restaurant');
      },
      // The error toast (with the API message) is already shown by tokenInterceptor.
      error: () => {
        this.submitting.set(false);
        this.confirmSubmitOpen.set(false);
      },
    });
  }

  // ---------- remove guest (bonus) ----------
  askRemove(person: Participant): void {
    this.removeTarget.set(person);
  }

  closeRemoveDialog(): void {
    if (!this.removing()) this.removeTarget.set(null);
  }

  confirmRemove(): void {
    const target = this.removeTarget();
    const groupId = this.invite()?.GroupReservationId;
    if (this.removing() || !target || !groupId) return;
    this.removing.set(true);

    this.service.removeSession$(groupId, target.id).subscribe({
      next: (sessions) => {
        this.participants.set(sessions.participants);
        this.markUpdated();
        this.removing.set(false);
        this.removeTarget.set(null);
        this.toast.success(`${target.name} was removed from the reservation`);
      },
      error: () => {
        this.removing.set(false);
        this.removeTarget.set(null);
      },
    });
  }

  // ---------- background sync (level 3) ----------
  private startSync(): void {
    if (this.syncSubscription || !this.isOpen()) return;
    this.syncSubscription = interval(GROUP_ORDER_SYNC_MS)
      .pipe(
        // exhaustMap: a new tick is ignored while the previous request has not answered yet.
        exhaustMap(() => {
          if (this.refreshing()) return EMPTY;
          this.refreshing.set(true);
          return this.fetchLatest();
        })
      )
      .subscribe();
  }

  private stopSync(): void {
    this.syncSubscription?.unsubscribe();
    this.syncSubscription = undefined;
  }

  /** Silent request: no page loader and no toast; on failure the last data stays on screen. */
  private fetchLatest() {
    const groupId = this.invite()?.GroupReservationId ?? '';
    return forkJoin({
      sessions: this.service.getSessions$(groupId, { silent: true }),
      status: this.service.getStatus$(groupId, { silent: true }),
    }).pipe(
      map(({ sessions, status }) => {
        this.participants.set(sessions.participants);
        this.status.set(status.status);
        this.markUpdated();
        this.refreshing.set(false);
        if (status.status !== 'Open') this.stopSync();
      }),
      catchError(() => {
        this.refreshFailed.set(true);
        this.refreshing.set(false);
        return EMPTY;
      })
    );
  }

  private markUpdated(): void {
    this.lastUpdated.set(new Date());
    this.refreshFailed.set(false);
  }
}
