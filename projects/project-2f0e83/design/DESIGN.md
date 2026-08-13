# Дизайн-система

## Направление
Полярный рассвет — чистый минимализм: холодная почти белая поверхность с еле уловимым синим подтоном, много воздуха, крупная спокойная типографика и один холодный акцент цвета рассветного неба, который появляется только в иконках и тонких деталях.

## Обоснование (референс)
Референса от заказчика не было; человек выбрал направление «Полярный рассвет — чистый минимализм» из предложенных. Характер собран из северного предрассветного света: холодная белизна с синим подтоном, один рассветный синий акцент, максимум воздуха и хайрлайн-границы вместо декора; ничего от «дефолтного лендинга из коробки» — ни цветных кнопок, ни теней-украшений, ни второго акцента.

## Правила для Исполнителя
- Ни одного цвета, размера, отступа, радиуса или тени вне переменных из tokens_css: любое значение в CSS страницы — либо var(--token), либо 0/100%/1px-хайрлайн из --hairline.
- Фон страницы: background: var(--dawn-wash) на body, no-repeat, background-color: var(--surface) как основа. Никаких других градиентов на странице.
- Шрифт ровно один — var(--font-sans), системный. Никаких @font-face, @import, ссылок на CDN и внешних запросов вообще.
- Заголовок «Аврора» — единственная визуальная доминанта: font-size: var(--text-hero), font-weight: var(--weight-semibold), line-height: var(--leading-tight), letter-spacing: var(--tracking-hero), color: var(--content). Никакой другой текст на странице не крупнее var(--text-xl).
- Над «Авророй» допустим один eyebrow-текст: font-size: var(--text-sm), text-transform: uppercase, letter-spacing: var(--tracking-eyebrow), color: var(--accent). Это единственное место, где акцент используется как цвет текста.
- Подзаголовок героя: var(--text-lg), color: var(--content-secondary), line-height: var(--leading-body), max-width: var(--measure-hero), margin-inline: auto (герой центрирован).
- Текст карточек: заголовок — var(--text-xl)/var(--leading-heading)/var(--weight-semibold)/var(--content); описание — var(--text-base)/var(--leading-body)/var(--content-secondary), max-width: var(--measure-body). Внутри карточки текст выровнен по левому краю.
- Запрещено использовать --content-muted и --border для текста: цвет текста только --content, --content-secondary или --accent (для eyebrow).
- Контейнер: max-width: var(--container-max); margin-inline: auto; padding-inline: var(--container-pad); на ширине ≥768px — var(--container-pad-lg).
- Вертикальный ритм: padding-block героя — var(--space-24) сверху и var(--space-16) снизу (на <768px: var(--space-16)/var(--space-12)); между eyebrow и заголовком — var(--space-4); между заголовком и подзаголовком — var(--space-6).
- Сетка карточек: display: grid; gap: var(--space-6); grid-template-columns: 1fr; на min-width: 768px — repeat(3, 1fr). Все три колонки равной ширины (1fr, без auto/max-content), карточки растянуты по высоте (align-items: stretch) — верх и низ выровнены.
- Карточка: background: var(--surface-elevated); border: var(--hairline); border-radius: var(--radius-lg); padding: var(--space-8); box-shadow: var(--shadow-1). Все три карточки имеют идентичные стили — ни одна не выделена цветом или тенью.
- Внутри карточки вертикальные отступы: иконка → заголовок var(--space-5), заголовок → описание var(--space-3). Одинаково во всех трёх карточках.
- Иконки — только инлайновый SVG в разметке, 24×24, stroke: currentColor, stroke-width: 1.5, fill: none, color: var(--accent); на плашке 48×48 с background: var(--accent-soft) и border-radius: var(--radius-md). Никаких <img>, эмодзи, шрифтовых иконок и внешних файлов.
- Движение: допустима ровно одна анимация — transition на карточке (transform и box-shadow) длительностью var(--duration-base) с var(--ease-standard); при :hover — transform: translateY(-2px) и box-shadow: var(--shadow-2). Никаких появлений по скроллу, keyframes и параллакса.
- Проверка на 375px обязательна: html, body { overflow-x: hidden } запрещён как способ спрятать проблему — вместо этого все контейнеры имеют max-width: 100% и box-sizing: border-box; горизонтальной прокрутки при 375px быть не должно, текст не обрезается (никаких фиксированных height у карточек).
- Никаких кликабельных элементов, кнопок, форм и ссылок: интерактивность ограничена hover-эффектом карточки; cursor остаётся default.
- Тексты — правдоподобный русский без плейсхолдеров: название «Аврора», содержательный подзаголовок и три разных преимущества с осмысленными заголовками и описанием в 1–2 предложения.
