import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '../theme';

/**
 * Rounds done out of today's total, with the missed ones drawn as a red
 * segment on the same track.
 *
 * Uses SVG because an arc genuinely needs one -- the usual plain-View tricks
 * for a ring rely on clipping two rotated halves and break at anything other
 * than exact quarters.
 *
 * Sized for the gradient header, so the palette assumes a dark background.
 */
export function ProgressRing({ done = 0, total = 0, missed = 0, size = 78, stroke = 7, caption }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  // Guard against a total of zero, and against the two segments together
  // claiming more than the ring when the data disagrees with itself.
  const safeTotal = Math.max(total, 1);
  const doneFraction = Math.min(done, safeTotal) / safeTotal;
  const missedFraction = Math.min(missed, Math.max(safeTotal - done, 0)) / safeTotal;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        {/* -90deg so the arc starts at the top rather than at three o'clock. */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={colors.glassBorder}
          strokeWidth={stroke}
          fill="none"
        />
        {missedFraction > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={colors.danger}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={circumference}
            // Drawn from the far end of the track so it cannot overlap `done`.
            strokeDashoffset={circumference * (1 - missedFraction)}
            strokeLinecap="round"
            transform={`rotate(${90 - missedFraction * 360} ${size / 2} ${size / 2})`}
          />
        ) : null}
        {doneFraction > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={colors.white}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - doneFraction)}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>

      <View style={styles.centre} pointerEvents="none">
        <Text style={styles.value}>
          {done}
          <Text style={styles.total}>/{total}</Text>
        </Text>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  centre: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 20, fontWeight: '700', color: colors.white, letterSpacing: -0.5 },
  total: { fontSize: 13, fontWeight: '600', color: colors.onGradientMuted },
  caption: { fontSize: 9, fontWeight: '700', color: colors.onGradientMuted, letterSpacing: 0.4 },
});
