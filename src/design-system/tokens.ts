/**
 * Typed references to the DSBox design tokens defined in `tokens.css`.
 *
 * Components should consume semantic tokens from this file. Raw palette values
 * deliberately remain in CSS so themes can change without a JavaScript rebuild.
 */

type CssVariable<Name extends string> = `var(--ds-${Name})`;

const cssVar = <Name extends string>(name: Name): CssVariable<Name> => `var(--ds-${name})`;

export const color = {
  background: {
    canvas: cssVar("color-bg-canvas"),
    sidebar: cssVar("color-bg-sidebar"),
    surface: cssVar("color-bg-surface"),
    raised: cssVar("color-bg-raised"),
    subtle: cssVar("color-bg-subtle"),
    hover: cssVar("color-bg-hover"),
    pressed: cssVar("color-bg-pressed"),
    selected: cssVar("color-bg-selected"),
    inverse: cssVar("color-bg-inverse")
  },
  text: {
    primary: cssVar("color-text-primary"),
    secondary: cssVar("color-text-secondary"),
    tertiary: cssVar("color-text-tertiary"),
    disabled: cssVar("color-text-disabled"),
    inverse: cssVar("color-text-inverse"),
    accent: cssVar("color-text-accent"),
    success: cssVar("color-text-success"),
    advisory: cssVar("color-text-advisory"),
    danger: cssVar("color-text-danger")
  },
  border: {
    subtle: cssVar("color-border-subtle"),
    default: cssVar("color-border-default"),
    strong: cssVar("color-border-strong"),
    focus: cssVar("color-border-focus")
  },
  accent: {
    solid: cssVar("color-accent-solid"),
    hover: cssVar("color-accent-hover"),
    soft: cssVar("color-accent-soft"),
    softHover: cssVar("color-accent-soft-hover")
  },
  status: {
    success: cssVar("color-status-success"),
    successSoft: cssVar("color-status-success-soft"),
    advisory: cssVar("color-status-advisory"),
    advisorySoft: cssVar("color-status-advisory-soft"),
    danger: cssVar("color-status-danger"),
    dangerSoft: cssVar("color-status-danger-soft"),
    info: cssVar("color-status-info"),
    infoSoft: cssVar("color-status-info-soft")
  },
  utility: {
    selection: cssVar("color-selection"),
    scrollbar: cssVar("color-scrollbar"),
    overlay: cssVar("color-overlay"),
    highlight: cssVar("color-highlight"),
    shadow: cssVar("color-shadow")
  },
  code: {
    background: cssVar("color-code-bg"),
    raised: cssVar("color-code-raised"),
    border: cssVar("color-code-border"),
    text: cssVar("color-code-text"),
    muted: cssVar("color-code-muted")
  },
  terminal: {
    background: cssVar("color-terminal-bg"),
    raised: cssVar("color-terminal-raised"),
    text: cssVar("color-terminal-text"),
    muted: cssVar("color-terminal-muted")
  },
  data: {
    one: cssVar("color-data-1"),
    two: cssVar("color-data-2"),
    three: cssVar("color-data-3"),
    four: cssVar("color-data-4")
  }
} as const;

export const typography = {
  family: {
    sans: cssVar("font-sans"),
    mono: cssVar("font-mono")
  },
  size: {
    caption: cssVar("font-size-caption"),
    metadata: cssVar("font-size-metadata"),
    chrome: cssVar("font-size-chrome"),
    body: cssVar("font-size-body"),
    chat: cssVar("font-size-chat"),
    titleSm: cssVar("font-size-title-sm"),
    titleMd: cssVar("font-size-title-md"),
    titleLg: cssVar("font-size-title-lg")
  },
  lineHeight: {
    compact: cssVar("line-height-compact"),
    chrome: cssVar("line-height-chrome"),
    body: cssVar("line-height-body"),
    chat: cssVar("line-height-chat"),
    title: cssVar("line-height-title")
  },
  weight: {
    regular: cssVar("font-weight-regular"),
    medium: cssVar("font-weight-medium"),
    semibold: cssVar("font-weight-semibold"),
    bold: cssVar("font-weight-bold")
  },
  tracking: {
    tight: cssVar("letter-spacing-tight"),
    normal: cssVar("letter-spacing-normal")
  }
} as const;

export const space = {
  0: cssVar("space-0"),
  1: cssVar("space-1"),
  1.5: cssVar("space-1-5"),
  2: cssVar("space-2"),
  2.5: cssVar("space-2-5"),
  3: cssVar("space-3"),
  4: cssVar("space-4"),
  5: cssVar("space-5"),
  6: cssVar("space-6"),
  8: cssVar("space-8"),
  10: cssVar("space-10"),
  12: cssVar("space-12"),
  16: cssVar("space-16")
} as const;

export const radius = {
  xs: cssVar("radius-xs"),
  sm: cssVar("radius-sm"),
  md: cssVar("radius-md"),
  lg: cssVar("radius-lg"),
  xl: cssVar("radius-xl"),
  full: cssVar("radius-full")
} as const;

export const shadow = {
  xs: cssVar("shadow-xs"),
  sm: cssVar("shadow-sm"),
  md: cssVar("shadow-md"),
  overlay: cssVar("shadow-overlay"),
  focus: cssVar("shadow-focus")
} as const;

export const motion = {
  duration: {
    instant: cssVar("duration-instant"),
    fast: cssVar("duration-fast"),
    normal: cssVar("duration-normal"),
    slow: cssVar("duration-slow")
  },
  easing: {
    standard: cssVar("ease-standard"),
    enter: cssVar("ease-enter"),
    exit: cssVar("ease-exit")
  }
} as const;

export const layout = {
  control: {
    sm: cssVar("control-size-sm"),
    md: cssVar("control-size-md"),
    lg: cssVar("control-size-lg"),
    hit: cssVar("control-hit-size")
  },
  sidebar: cssVar("layout-sidebar-width"),
  topbar: cssVar("layout-topbar-height"),
  readingWidth: cssVar("layout-reading-width")
} as const;

export const tokens = {
  color,
  typography,
  space,
  radius,
  shadow,
  motion,
  layout
} as const;

export type DSBoxTokens = typeof tokens;
export type ColorTokens = typeof color;
export type SpaceToken = keyof typeof space;
export type RadiusToken = keyof typeof radius;
export type ControlSize = keyof typeof layout.control;
