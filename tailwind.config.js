/** @type {import('tailwindcss').Config} */
const withAlpha = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ['./src/ui/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: withAlpha('--bg'),
          elevated: withAlpha('--bg-elevated'),
          hover: withAlpha('--bg-hover'),
          active: withAlpha('--bg-active'),
          inset: withAlpha('--bg-inset'),
        },
        fg: {
          DEFAULT: withAlpha('--fg'),
          muted: withAlpha('--fg-muted'),
          subtle: withAlpha('--fg-subtle'),
        },
        border: {
          DEFAULT: withAlpha('--border'),
          strong: withAlpha('--border-strong'),
        },
        accent: {
          DEFAULT: withAlpha('--accent'),
          hover: withAlpha('--accent-hover'),
          muted: withAlpha('--accent-muted'),
        },
        stream: {
          DEFAULT: withAlpha('--stream'),
          active: withAlpha('--stream-active'),
          muted: withAlpha('--stream-muted'),
        },
        danger: {
          DEFAULT: withAlpha('--danger'),
          hover: withAlpha('--danger-hover'),
          muted: withAlpha('--danger-muted'),
        },
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }], // 11px
        xs: ['0.75rem', { lineHeight: '1.05rem' }], // 12px
        sm: ['0.8125rem', { lineHeight: '1.2rem' }], // 13px
        base: ['0.875rem', { lineHeight: '1.35rem' }], // 14px
        md: ['0.9375rem', { lineHeight: '1.45rem' }], // 15px
        lg: ['1.0625rem', { lineHeight: '1.5rem' }], // 17px
        xl: ['1.375rem', { lineHeight: '1.7rem' }], // 22px
        '2xl': ['1.75rem', { lineHeight: '2.1rem' }], // 28px
      },
      borderRadius: {
        md: '8px',
        lg: '10px',
        xl: '14px',
        '2xl': '18px',
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        pop: 'var(--shadow-pop)',
        float: 'var(--shadow-float)',
      },
      animation: {
        'fade-in': 'fadeIn 140ms ease-out',
        'scale-in': 'scaleIn 130ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slideDown 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.4s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.96) translateY(-4px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
