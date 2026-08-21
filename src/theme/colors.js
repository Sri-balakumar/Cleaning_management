/**
 * 369 Showroom Check palette. Indigo -> sky gradient brand with a slate neutral ramp.
 * Keep every colour used by the app here so screens never hardcode hex values.
 */
export const colors = {
  // Brand
  primary: '#4F46E5',
  primaryDark: '#3730A3',
  primaryLight: '#818CF8',
  // Material 3 "secondary container": the pill behind an active tab icon.
  primarySoft: '#E0E7FF',
  accent: '#06B6D4',
  // Gradients: readonly tuples (via the trailing `as const`), which satisfies
  // LinearGradient's [ColorValue, ColorValue, ...ColorValue[]] signature.
  gradient: ['#312E81', '#4F46E5', '#0EA5E9'],
  gradientSoft: ['#6366F1', '#0EA5E9'],
  // One hue with a little depth. The old indigo -> cyan shift fought both the
  // gradient behind the login card and the blue in the 369 mark.
  gradientButton: ['#4F46E5', '#4338CA'],
  gradientAvatar: ['#6366F1', '#06B6D4'],
  // Surfaces
  background: '#F1F5F9',
  surface: '#FFFFFF',
  surfaceAlt: '#F8FAFC',
  overlay: 'rgba(15, 23, 42, 0.55)',
  // Text
  text: '#0F172A',
  textSecondary: '#475569',
  textMuted: '#94A3B8',
  textOnPrimary: '#FFFFFF',
  // Lines
  border: '#E2E8F0',
  borderStrong: '#CBD5E1',
  // State
  success: '#10B981',
  successBg: '#ECFDF5',
  successBorder: '#A7F3D0',
  danger: '#DC2626',
  dangerBg: '#FEF2F2',
  dangerBorder: '#FECACA',
  warning: '#D97706',
  warningBg: '#FFFBEB',
  warningBorder: '#FDE68A',
  info: '#0EA5E9',
  // Glass (used on top of the gradient header)
  glass: 'rgba(255, 255, 255, 0.16)',
  glassStrong: 'rgba(255, 255, 255, 0.24)',
  glassBorder: 'rgba(255, 255, 255, 0.28)',
  onGradientMuted: 'rgba(255, 255, 255, 0.72)',
  white: '#FFFFFF',
  black: '#000000',
};
