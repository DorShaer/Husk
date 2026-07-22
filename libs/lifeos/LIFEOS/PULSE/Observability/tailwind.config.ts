import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    fontSize: {
      'xs': ['0.875rem', { lineHeight: '1.25rem' }],   // was 0.75rem (12px) → 14px
      'sm': ['1rem', { lineHeight: '1.5rem' }],         // was 0.875rem (14px) → 16px
      'base': ['1.0625rem', { lineHeight: '1.6rem' }],  // was 1rem (16px) → 17px
      'lg': ['1.25rem', { lineHeight: '1.75rem' }],     // was 1.125rem (18px) → 20px
      'xl': ['1.375rem', { lineHeight: '1.875rem' }],   // was 1.25rem (20px) → 22px
      '2xl': ['1.625rem', { lineHeight: '2rem' }],      // was 1.5rem (24px) → 26px
      '3xl': ['2rem', { lineHeight: '2.25rem' }],       // was 1.875rem (30px) → 32px
      '4xl': ['2.5rem', { lineHeight: '2.75rem' }],     // was 2.25rem (36px) → 40px
      '5xl': ['3.25rem', { lineHeight: '1' }],           // was 3rem (48px) → 52px
    },
  	extend: {
  		colors: {
  			/* Pulse design tokens (globals.css :root) */
  			ground: 'var(--ground)',
  			surface: {
  				'1': 'var(--surface-1)',
  				'2': 'var(--surface-2)',
  				'3': 'var(--surface-3)'
  			},
  			line: {
  				'1': 'var(--line-1)',
  				'2': 'var(--line-2)',
  				'3': 'var(--line-3)'
  			},
  			ink: {
  				'1': 'var(--ink-1)',
  				'2': 'var(--ink-2)',
  				'3': 'var(--ink-3)'
  			},
  			ok: 'var(--ok)',
  			warn: 'var(--warn)',
  			err: 'var(--err)',
  			dim: {
  				health: 'var(--health)',
  				money: 'var(--money)',
  				freedom: 'var(--freedom)',
  				creative: 'var(--creative)',
  				relationships: 'var(--relationships)',
  				rhythms: 'var(--rhythms)'
  			},
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			ring: 'hsl(var(--ring))',
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			input: 'hsl(var(--input))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			}
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		fontFamily: {
  			sans: [
  				'var(--font-geist-sans)',
  				'system-ui',
  				'sans-serif'
  			],
  			mono: [
  				'var(--font-geist-mono)',
  				'monospace'
  			]
  		},
  		keyframes: {
  			'pulse-glow': {
  				'0%, 100%': {
  					opacity: '1'
  				},
  				'50%': {
  					opacity: '0.5'
  				}
  			},
  			'slide-up': {
  				'0%': {
  					transform: 'translateY(10px)',
  					opacity: '0'
  				},
  				'100%': {
  					transform: 'translateY(0)',
  					opacity: '1'
  				}
  			},
  			'number-tick': {
  				'0%': {
  					transform: 'translateY(-100%)',
  					opacity: '0'
  				},
  				'100%': {
  					transform: 'translateY(0)',
  					opacity: '1'
  				}
  			}
  		},
  		animation: {
  			'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
  			'slide-up': 'slide-up 0.3s ease-out',
  			'number-tick': 'number-tick 0.3s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
