/**
 * Colours come from CSS custom properties so the palette can be themed without a
 * rebuild. The `<alpha-value>` placeholder is what lets Tailwind opacity
 * modifiers (bg-primary/10, divide-border/50) work against a custom property.
 *
 * Hardcoded colours are forbidden by docs/UI_UX_AGENT_STANDARDS.md — use these
 * token names, never a hex value or a stock Tailwind shade, except for the
 * semantic red/green/amber exceptions the guide allows.
 */
const token = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: token('primary'),
        'primary-dark': token('primary-dark'),
        accent: token('accent'),
        surface: token('surface'),
        'surface-muted': token('surface-muted'),
        control: token('control'),
        text: token('text'),
        'text-muted': token('text-muted'),
        border: token('border'),
        'border-strong': token('border-strong'),
        sidebar: token('sidebar'),
        'sidebar-foreground': token('sidebar-foreground'),
        'sidebar-muted': token('sidebar-muted'),
        'on-primary': token('on-primary'),
        success: token('success'),
        warning: token('warning'),
        danger: token('danger'),
      },
    },
  },
  plugins: [],
};
