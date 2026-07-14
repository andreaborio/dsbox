# DSBox design system

This system gives DSBox one precise visual language for chat, model management, downloads, runtime controls, and settings. It is desktop-first, neutral, quiet, and intentionally free of decorative gradients. Product copy and component labels are English-only.

The package is isolated under `src/design-system` so existing screens can migrate incrementally.

## Principles

1. **The default path is obvious.** One primary action per surface; secondary controls stay quiet.
2. **Readable before compact.** Chat is 15px/1.62, application body is 14px/1.55, and chrome is 13px/1.45. Eleven-pixel text is reserved for short badges and captions.
3. **Neutral by default.** Surfaces and navigation use neutral values. Accent and status colors communicate state, not decoration.
4. **Advice is not failure.** SSD-streaming performance guidance uses the restrained `advisory` tone. It never looks like a blocking error.
5. **One geometry system.** Visible controls are 36px by default with a 40px hit target. Spacing follows a 4px base grid.
6. **Motion explains change.** Transitions run for 120–240ms and respect reduced-motion preferences.
7. **The UI tells the truth.** `Downloading`, `Verifying`, `Preparing`, and `Ready` are separate states. Generic `Processing` is not a product state.

## Integration

Import the CSS once, before the existing stylesheet, in `src/main.tsx`:

```tsx
import "./design-system/design-system.css";
import "./styles.css";
```

Import primitives from the barrel:

```tsx
import { Badge, Button, InlineNotice, Progress, Surface } from "./design-system";
```

No provider is required. Light mode is the default. A future themed subtree can set `data-ds-color-scheme="dark"` on its root element. The design-system selectors use a `ds-` prefix and CSS layers, so legacy unlayered styles can coexist during migration.

## Token model

Use semantic roles rather than palette values:

```tsx
import { color, radius, space } from "./design-system";

const style = {
  color: color.text.secondary,
  gap: space[3],
  borderRadius: radius.md
};
```

The typed exports in `tokens.ts` mirror the CSS variables in `tokens.css`.

### Core roles

| Family | Roles |
| --- | --- |
| Background | canvas, sidebar, surface, raised, subtle, hover, pressed, selected, inverse |
| Text | primary, secondary, tertiary, disabled, inverse, accent, success, advisory, danger |
| Border | subtle, default, strong, focus |
| Status | success, advisory, danger, info and matching soft backgrounds |
| Type | caption 11px, metadata 12px, chrome 13px, body 14px, chat 15px |
| Layout | 232px sidebar, 60px top bar, 760px reading/composer width |
| Control | 32px small, 36px default, 40px large, 40px minimum hit target |

Use body text for settings and model descriptions. Use metadata for speeds, sizes, timestamps, and secondary values. Use captions only for compact badges and short eyebrow labels.

## Components

### Button

```tsx
<Button variant="primary">Download & use</Button>
<Button variant="secondary">Choose another model</Button>
<Button variant="ghost">Cancel</Button>
<Button variant="danger">Remove model</Button>
<Button loading loadingLabel="Downloading model">Download & use</Button>
```

- Variants: `primary`, `secondary`, `ghost`, `danger`.
- Sizes: `sm`, `md`, `lg`.
- `type="button"` is the safe default; set `type="submit"` explicitly in forms.
- Loading disables interaction, applies `aria-busy`, and preserves the button width.
- Do not place two primary buttons in one panel.

### IconButton

```tsx
<IconButton label="Stop generation" icon={<Square size={17} />} />
```

`label` is required and becomes the accessible name. Add `tooltip` only when a visible nearby label does not explain the action.

### Badge

```tsx
<Badge tone="success" dot>Ready</Badge>
<Badge tone="advisory" dot>May be slow</Badge>
<Badge tone="neutral">90 GB</Badge>
```

Badges summarize short facts. A model card should normally show no more than two. Use the `advisory` tone for predictions such as `May be slow` or `SSD streaming`; reserve `danger` for corruption, incompatibility, or a failed operation.

### Surface

```tsx
<Surface tone="default" padding="lg" radius="lg">
  ...
</Surface>
```

Use `raised` with elevation only for menus, dialogs, and other true overlays. Content cards normally use a border and no shadow.

### MenuRow

```tsx
<MenuRow
  icon={<HardDrive />}
  label="Model storage"
  description="126 GB available"
  trailing="Change"
  showChevron
/>
```

`MenuRow` is a button, not a generic layout container. It has a 44px minimum height and exposes selected state with `aria-pressed`.

### Progress

```tsx
<Progress label="Downloading model" value={7.4} max={11.8} valueText="7.4 of 11.8 GB" />
<Progress label="Preparing model" valueText="Preparing" />
```

Omit `value` for indeterminate work. Always provide a specific label. The component clamps invalid values and exposes native progressbar semantics.

### InlineNotice

```tsx
<InlineNotice tone="advisory" title="May be slow on this Mac">
  DS4 can stream this 90 GB model from SSD, but generation may be slow with 16 GB of unified memory.
</InlineNotice>
```

`danger` uses an alert role. Other tones use a non-interruptive status role. Keep the message factual and give the user a way forward.

## Product patterns

### SSD-streaming recommendation

Compatibility and predicted performance are separate facts:

```text
Verified for DS4            compatibility
May be slow · SSD streaming performance guidance
```

A large model remains downloadable when disk space is sufficient. Display the advisory once before download, then remember acknowledgement. Never claim that a model does not fit solely because its file is larger than unified memory.

Recommended model card hierarchy:

1. Model name, one line.
2. Plain-language purpose, two lines maximum.
3. Size and quantization as neutral metadata.
4. At most one recommendation or performance badge.
5. One `Download & use` primary action.

### Download states

| State | UI treatment |
| --- | --- |
| Available | Model size and `Download & use` |
| Downloading | Determinate progress, bytes, rate, ETA, pause and cancel |
| Verifying | Indeterminate neutral progress; no fake percentage |
| Preparing | Specific task copy and a stop action if safe |
| Ready | Success dot and `Start chatting` |
| Interrupted | Preserved progress and `Resume download` |
| Failed | Inline danger notice with retry and details |

### Chat shell

- Use the same 760px maximum width for messages and composer.
- Chat copy is `15px / 1.62`; metadata is `12px / 1.45`.
- Keep the composer neutral with an 18px radius and 8px internal padding.
- Put one reasoning control in the composer; do not duplicate it in the top toolbar.
- Streaming, navigation, and thread switching must not destroy active generation state.

## Accessibility

- Preserve a visible focus ring on every interactive element.
- Use native buttons for actions; do not add click handlers to surfaces.
- Keep a minimum 40px pointer target and 44px for menu rows.
- Use icon plus text or an explicit accessible label; color is never the only state signal.
- Progress bars require a meaningful label and determinate values when known.
- Check text and icon contrast in both token themes.
- Never disable zoom or suppress platform keyboard behavior.
- Motion duration tokens become zero when reduced motion is requested. Indeterminate spinners slow down instead of flashing.

## Migration order

1. Import `design-system.css` without replacing any component.
2. Replace legacy `.button` and `.icon-button` instances with `Button` and `IconButton`.
3. Replace model/status pills with `Badge`; remove redundant pills instead of translating all of them.
4. Replace download and resource bars with `Progress`.
5. Convert settings rows and menus to `MenuRow` and `Surface`.
6. Apply type roles and the 760px chat/composer width.
7. Remove the migrated legacy CSS only after screenshot and keyboard verification.

Verify each tranche at 1280×720, 1440×900, and 1728×1117, plus keyboard-only and reduced-motion operation.
