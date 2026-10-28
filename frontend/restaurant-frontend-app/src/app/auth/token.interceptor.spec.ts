import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ToastService } from '../services/toast/toast.service';
import { AuthenticationService } from './services/authentication.service';
import { SKIP_ERROR_TOAST } from './skip-error-toast.context';
import { tokenInterceptor } from './token.interceptor';

const URL = 'https://test.api/reservations';

describe('tokenInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let toastService: jasmine.SpyObj<ToastService>;
  let authService: jasmine.SpyObj<AuthenticationService>;

  beforeEach(() => {
    toastService = jasmine.createSpyObj<ToastService>('ToastService', ['error']);
    authService = jasmine.createSpyObj<AuthenticationService>('AuthenticationService', [
      'getTokens',
    ]);
    authService.getTokens.and.returnValue(null);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([tokenInterceptor])),
        provideHttpClientTesting(),
        { provide: ToastService, useValue: toastService },
        { provide: AuthenticationService, useValue: authService },
      ],
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('shows the server message in a toast for a 400 response', () => {
    http.post(URL, {}).subscribe({ error: () => undefined });

    httpMock
      .expectOne(URL)
      .flush({ message: 'Overlaps' }, { status: 400, statusText: 'Bad Request' });

    expect(toastService.error).toHaveBeenCalledWith('Overlaps', 'Error');
  });

  it('does not show a toast but still rethrows when SKIP_ERROR_TOAST is set', () => {
    let receivedStatus: number | undefined;
    http
      .post(URL, {}, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) })
      .subscribe({ error: (error) => (receivedStatus = error.status) });

    httpMock
      .expectOne(URL)
      .flush({ message: 'Overlaps' }, { status: 400, statusText: 'Bad Request' });

    expect(toastService.error).not.toHaveBeenCalled();
    expect(receivedStatus).toBe(400);
  });

  it('adds the owner token to /guest/groups/ requests (group pre-order screen)', () => {
    authService.getTokens.and.returnValue({ idToken: 'owner-id-token' } as ReturnType<AuthenticationService['getTokens']>);
    const groupUrl = 'https://test.api/guest/groups/grp-1/sessions';
    http.get(groupUrl).subscribe();

    const req = httpMock.expectOne(groupUrl);
    expect(req.request.headers.get('Authorization')).toBe('Bearer owner-id-token');
    req.flush({ participants: [], total: 0 });
  });

  it('keeps the guest session token on other /guest/ requests', () => {
    authService.getTokens.and.returnValue({ idToken: 'owner-id-token' } as ReturnType<AuthenticationService['getTokens']>);
    const guestUrl = 'https://test.api/guest/sessions/gs-1/dishes';
    http.post(guestUrl, {}, { headers: { Authorization: 'Bearer guest-token' } }).subscribe();

    const req = httpMock.expectOne(guestUrl);
    expect(req.request.headers.get('Authorization')).toBe('Bearer guest-token');
    req.flush({});
  });

  it('does not show a toast for a silent /guest/groups/ request', () => {
    const groupUrl = 'https://test.api/guest/groups/grp-1/sessions';
    http
      .get(groupUrl, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) })
      .subscribe({ error: () => undefined });

    httpMock.expectOne(groupUrl).flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });

    expect(toastService.error).not.toHaveBeenCalled();
  });
});
