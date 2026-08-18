import { colors } from './colors';
export const typography = {
  display: { fontSize: 30, fontWeight: '700', letterSpacing: -0.6, color: colors.text },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, color: colors.text },
  heading: { fontSize: 17, fontWeight: '700', color: colors.text },
  body: { fontSize: 15, fontWeight: '500', color: colors.text },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  caption: { fontSize: 12, fontWeight: '500', color: colors.textMuted },
  /** Small all-caps section header used above grouped cards. */
  overline: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
};
