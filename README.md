<p align="center"><img src="icon.png" width="96" alt=""></p>

<h1 align="center">ArtReview</h1>

<p align="center">Правки до відео-шоту за хвилину: відкрив шот, поставив пронумеровані піни з коментарями, натиснув одну кнопку — і вставляєш у Telegram чи Slack готове MP4, на якому нотатки вже намальовані.</p>

Для VFX- та анімаційних художників і їхніх клієнтів. Інтерфейс навмисно простий, щоб правки міг лишити й режисер чи клієнт, який ніколи не відкривав Nuke: **відкрити відео → клікнути → написати → скопіювати**.

## Як користуватися

1. **Відкрий відео.** Кнопка «Відкрити відео» або просто перетягни файл у вікно (MP4, MOV, M4V, WebM, MKV).
2. **Постав пін.** Клікни по кадру там, де потрібна правка, і пиши коментар (<kbd>Enter</kbd> — готово, <kbd>Shift+Enter</kbd> — новий рядок). Пін видно 3 секунди від поточного кадру, межі тягнуться на таймлайні. Якщо правка стосується предмета, який рухається, візьми інструмент «Об'єкт» і обведи його рамкою: пін поїде за ним по всьому шоту.
3. **Скопіюй.** «Скопіювати відео з нотатками» (<kbd>Ctrl+Shift+C</kbd>) збирає MP4 з нотатками поверх картинки й кладе його в буфер обміну. Відкрий чат і натисни <kbd>Ctrl+V</kbd>.

Після експорту вгорі з'являється плашка з назвою файлу: її можна просто перетягнути в чат, а клік показує файл у папці.

## Клавіші

| Клавіша | Дія |
|---|---|
| <kbd>P</kbd> | Пін: клік по кадру — нова нотатка |
| <kbd>O</kbd> | Об'єкт: обвести рамкою предмет, пін їде за ним (коли нотатку вибрано — див. нижче) |
| <kbd>V</kbd> | Вибір: тягнути пін, подвійний клік — редагувати текст |
| <kbd>I</kbd> / <kbd>O</kbd> | Початок / кінець **вибраної** нотатки на поточному кадрі. Нотатку вибирають кліком по її піну, картці чи смузі на таймлайні; щойно написана нотатка після <kbd>Enter</kbd> уже не вибрана, тож <kbd>O</kbd> тоді — інструмент «Об'єкт» |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | Видалити вибрану нотатку (<kbd>Ctrl+Z</kbd> — повернути) |
| <kbd>Space</kbd> | Відтворення / пауза |
| <kbd>←</kbd> <kbd>→</kbd> | Кадр назад / вперед (з <kbd>Shift</kbd> — по 10) |
| <kbd>Home</kbd> / <kbd>End</kbd> | Перший / останній кадр |
| <kbd>Ctrl+Z</kbd>, <kbd>Ctrl+Shift+Z</kbd> / <kbd>Ctrl+Y</kbd> | Скасувати / повернути |
| <kbd>Ctrl+Shift+C</kbd> | Скопіювати відео з нотатками |

Клавіші працюють і на українській розкладці.

## Що потрапляє в буфер обміну

| Система | Що кладеться | Як вставити |
|---|---|---|
| **Windows** | Сам файл MP4 (як після <kbd>Ctrl+C</kbd> у Провіднику) і, якщо в налаштуваннях увімкнено «Текст нотаток разом з відео», ще й текст нотаток — одним записом | <kbd>Ctrl+V</kbd> у Telegram, Slack, WhatsApp Desktop. Месенджер бере файл; чи підхопить він ще й текст, залежить від самого месенджера. Якщо тексту немає — «Копіювати текст» і встав другим повідомленням. |
| **macOS** | Лише файл (текст разом із файлом macOS тут не передає) | <kbd>Cmd+V</kbd>; текст — кнопкою «Копіювати текст» |
| **Linux** | Файл як `text/uri-list` через `xclip` | Потрібен встановлений `xclip`. Без нього — перетягни плашку з файлом у чат. |

Текст нотаток виглядає так:

```
shot_010.mp4 — 2 нотатки
1. 00:00:00:12 (кадр 13–85) — Тінь темніша
2. 00:00:02:03 (кадр 52–124) — Прибрати відблиск на склі
```

## Куди що зберігається

- **Відео з нотатками** — у папці `Відео/ArtReview` (на Windows `C:\Users\<ім'я>\Videos\ArtReview`), назва `shot_010_notes_<дата>_<час>.mp4`. Поруч лягає `.md` з тим самим списком нотаток, частотою кадрів, розміром і координатами пінів. Папку можна змінити в налаштуваннях (шестерня).
- **Нотатки зберігаються самі**, весь час, окремо для кожного відео. Закрив програму — нічого не пропало: відкриєш те саме відео, і нотатки повернуться («Нотатки відновлено»). Лежать у папці даних програми: Windows `%APPDATA%\ArtReview\reviews`, macOS `~/Library/Application Support/ArtReview/reviews`, Linux `~/.config/ArtReview/reviews`. Там же `settings.json` і журнал `artreview.log`.
- **«Зберегти нотатки»** записує файл `.artreview` (JSON: шлях до відео та нотатки), щоб передати його комусь або відкрити пізніше. Відео в нього не вшивається.

## Чесно про обмеження

- Стеження за об'єктом — простий власний трекер (оптичний потік + пошук за шаблоном), без нейромереж. Добре тримає предмет, що їде, повертається чи трохи змінює розмір; губиться на різкому русі, сильному розмитті, повному перекритті надовго чи коли предмет змінюється до невпізнання. Втрачені кадри видно червоним на таймлайні, пін тоді стоїть там, де предмет бачили востаннє.
- Відео декодується через WebCodecs: H.264, H.265 (якщо підтримує система), VP8/VP9, AV1. ProRes, DNxHD та інші проміжні кодеки не відкриваються — перекодуй у H.264.
- Експорт завжди перекодовує картинку в H.264; за замовчуванням довга сторона не більша за 1920 px (у налаштуваннях: 1280 / 1920 / оригінал).
- Автозбереження прив'язане до шляху й розміру файлу: якщо відео перейменувати, перемістити чи перерендерити, нотатки самі не підтягнуться — відкрий збережений `.artreview`.
- Обмеження месенджерів на розмір файлу ніхто не скасовував: довгий шот в оригінальному розмірі може не пролізти.
- Інсталятори не підписані платним сертифікатом: Windows може показати «Windows захистив ваш ПК» → «Докладніше» → «Усе одно запустити»; на macOS перший раз — правий клік → «Відкрити».

## Запуск із коду

Потрібен [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start
```

`npm run dist` збирає інсталятор для поточної системи в `dist/`. Інсталятори для Windows, macOS і Linux збирає GitHub Actions (`.github/workflows/build.yml`): тег `v*` публікує їх у реліз.

## Як влаштовано

Той самий стек, що й у [ArtFrames](https://github.com/artsocity23-ux/artframes): **Electron** без збирача, інтерфейс — звичайні ES-модулі, відео декодується й кодується через WebCodecs бібліотекою [Mediabunny](https://mediabunny.dev). Усе працює офлайн, нічого не відправляється в мережу.

| Файл | |
|---|---|
| `main.js` | вікно, діалоги, читання відео шматками, налаштування, автозбереження нотаток, буфер обміну, перетягування файлу в чат |
| `clipboard.js` | файл (і текст) у системний буфер обміну: Windows — PowerShell, macOS — `osascript`, Linux — `xclip`; шлях і текст передаються через змінні середовища / аргументи, ніколи не вклеюються в команду |
| `preload.js` | міст `window.ar` між вікном і `main.js` |
| `index.html` / `app.css` / `src/app.js` | інтерфейс: інструменти, нотатки, таймлайн, відтворення, клавіші, undo |
| `src/video.js` | відкриття відео, точний доступ до кадру, кеш, звук |
| `src/overlay.js` | малювання пінів, рамок і бульбашок — одна функція і для перегляду, і для експорту |
| `src/notes.js` | нотатки: положення на кадрі, таймкоди, текст і Markdown |
| `src/track.js` / `src/tracker.js` / `src/track-worker.js` | стеження за об'єктом у фоновому потоці |
| `src/export.js` | MP4 з нотатками, підсумкова картка в кінці, звук |
| `donate.html` / `donate.js` / `donate.json` | вікно «Підтримати»; порожні пункти в `donate.json` не показуються |
| `selftest.js` | наскрізний тест без людини |
| `make-icon.js` | генерує іконки (`icon.png`, `icon.ico`, `build/icon.png`) |

## Самоперевірка

```bash
npm run selftest            # уся програма справжніми кліками й клавішами, звіт у selftest-out/report.json
npm test                    # трекер на синтетичних кадрах
node test/clipboard.test.js # Windows: справжній буфер обміну — файл + текст, потім повертає твій текст назад
```

Самоперевірка генерує власне тестове відео; файли з диска не використовуються. Тест буфера обміну зберігає текст, який був у буфері, і повертає його після перевірки (картинку з буфера він не збереже).

## Підтримати

ArtReview безкоштовний і з відкритим кодом. Підтримати автора можна кнопкою ♥ у правому верхньому куті програми (там QR-коди).

## English

**ArtReview** is a tiny desktop app for art-direction notes on a video shot. Open a shot, click to drop numbered pins with comments (a pin can follow a moving object through the shot), press **Copy video with notes** (<kbd>Ctrl+Shift+C</kbd>), and paste a ready MP4 with the notes burned in straight into Telegram, Slack or WhatsApp Desktop.

- **Clipboard:** on Windows the MP4 goes on the clipboard as a file (like Explorer's copy), optionally together with the notes as text; on macOS only the file; on Linux a `text/uri-list` via `xclip`. You can also drag the exported file from the chip in the top bar into a chat.
- **Files:** exports go to `Videos/ArtReview` (MP4 + a Markdown list of notes). Notes autosave per video in the app data folder and come back when you reopen the same file; **Save notes** writes a portable `.artreview` JSON.
- **Limits:** the object follower is a simple optical-flow + template tracker (no neural networks) and can lose fast, blurred or long-occluded objects; intermediate codecs like ProRes do not open; export is always H.264.
- **Stack:** the same as [ArtFrames](https://github.com/artsocity23-ux/artframes) — Electron, plain ES modules, WebCodecs via Mediabunny. Fully offline.
- **Run from source:** `npm install`, `npm start`; `npm run selftest` for the end-to-end check, `npm test` for the tracker, `node test/clipboard.test.js` for the real Windows clipboard.

## Ліцензія

[MIT](LICENSE). Mediabunny — MPL-2.0.
