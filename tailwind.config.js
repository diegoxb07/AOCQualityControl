/** Tailwind config for the static build (css/tailwind.css).
 *  Regenerate after adding/removing Tailwind classes in index.html or js/*.js:
 *    npx tailwindcss@3 -i tailwind.input.css -o css/tailwind.css --minify
 *  Theme matches the old cdn.tailwindcss.com inline config exactly. */
module.exports = {
  content: ['./index.html', './js/*.js'],
  // Classes toggled from JS (classList.add/toggle), listed explicitly so a scanner
  // miss can never drop one from the compiled CSS. Color classes below are the small,
  // hand-written theme-aware utilities defined in css/app.css (bound to CSS variables so
  // they follow [data-theme]), NOT Tailwind color utilities - Tailwind just needs to not
  // purge them since they're built via classList.add/toggle rather than literal markup.
  safelist: [
    'hidden', 'flex', 'block', 'grayscale', 'grayscale-0', 'saturate-0',
    'opacity-40', 'opacity-50', 'opacity-60', 'opacity-70', 'pointer-events-none', 'cursor-not-allowed',
    'text-accent', 'text-faint', 'text-muted', 'text-accent-ink', 'text-danger',
    'font-semibold', 'font-medium', 'border-2', 'border-accent', 'border-danger',
    'bg-panel-strip', 'bg-accent-soft', 'bg-accent', 'bg-danger-soft',
    'hover:bg-accent', 'accent-accent', 'w-3.5', 'h-3.5'
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope','ui-sans-serif','system-ui','sans-serif'],
        mono: ['IBM Plex Mono','ui-monospace','SFMono-Regular','monospace'],
        serif: ['Manrope','sans-serif']
      }
    }
  }
};
