# Домашка Frontend: екран Owner групового pre-order

Виконано всі три рівні та бонус Remove Guest. Скріншоти лежать у папці `homework-screenshots/`.

## Що зроблено

| Рівень | Що зроблено | Тести |
|---|---|---|
| Практичне | Картка учасника `ParticipantCardComponent`: заголовок, страви, Subtotal, статус кошика текстом | 8 |
| 1 | Сторінка `/reservations/:reservationId/group-order` за макетом: шапка з адресою, датою, часом і «4 of 5 guests», Grand Total, адаптивна верстка до 375 px | 5 |
| 2 | Сервіс `GroupOrdersService`. Сторінка бере дані з API і тримає стан у `signal()` та `computed()`. Є «My Pre-Order», блок «Consolidated pre-order», Grand Total лише з підтверджених кошиків, жовта плашка, бейдж статусу, Submit через `<app-modal>` зі захистом від подвійного кліку, стани loading, error («Try again»), not found і empty | 5 + 13 |
| 3 | Синхронізація кожні 15 с, поки група `Open`, через `interval` + `exhaustMap`. Фонові запити тихі (`{ silent: true }` → `SKIP_ERROR_TOAST`). Є «Updated at …», кнопка «Refresh» і «Couldn't refresh. Showing data from …». Таймер зупиняється після Submit і при виході зі сторінки | 3 + 6 |
| Бонус | Remove Guest: кнопка з `aria-label="Remove <ім'я>"` лише біля гостей і лише поки група відкрита, діалог підтвердження, список оновлюється з відповіді `DELETE` | 1 + 5 |

Додатково:

- **`tokenInterceptor`** не додавав токен Cognito до адрес `/guest/...`. Через це `GET /guest/groups/{id}/sessions` на справжньому API отримував 401. Тепер для `/guest/groups/` додається токен власника, але лише якщо в запиті ще немає заголовка `Authorization`. Токен гостя на інших `/guest/` запитах не змінюється. Також для `/guest/` запитів тепер враховується `SKIP_ERROR_TOAST`. Додано 3 тести.
- **Картка бронювання** отримала кнопку «Group Pre-Order» (макет 03): вона з'являється у Customer для бронювань на 2+ гостей.
- **`environment.development.ts`** тепер вказує на бекенд, задеплоєний на бекенд-треку.

## Як перевірено

- `npm run test:hw`: **67 із 67** тестів зелені (26 тестів helpers з архіву + 41 тест домашки).
- `npx tsc -p tsconfig.app.json --noEmit` і `npx tsc -p tsconfig.spec.json --noEmit`: 0 помилок.
- `BACKEND_URL=https://example.com npm run build`: збірка пройшла, `Bundle check passed`. Окремий chunk сторінки займає 23.55 kB, initial bundle 643.30 kB.
- Повний `npm test`: червоних тестів 46 і до моїх змін, і після. Нових падінь немає, додалося 44 зелені тести.
- Вручну на моках (`?demo`): усі стани екрана, Submit, Remove Guest, ширина 375 px без горизонтальної прокрутки.
- Наскрізно на справжньому API з реальним логіном Customer. Троє гостей приєдналися через `POST /guest/sessions`. Один гість підтвердив кошик, поки Owner тримав сторінку відкритою, і через 15 с екран сам показав «Submitted» без перезавантаження. Потім Owner видалив одного гостя і відправив замовлення. У DynamoDB order отримав статус `SubmittedByCustomer` з об'єднаними стравами, група отримала статус `Submitted`.

## Використання AI

Код написано з Claude (Anthropic). Я перевірив результат тестами, збіркою, скріншотами й наскрізним сценарієм на своєму AWS.

## Відомі обмеження

- Owner session створюється автоматично, але власник поки не може додавати в неї страви. Endpoint-и кошика перевіряють токен гостя, а у власника токен Cognito. Власний pre-order Owner зберігається в order бронювання, і бекенд додає до нього страви гостей під час submit.
- Жовта плашка рахує й порожню owner session як «ще не підтвердила кошик».
