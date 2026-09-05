import React from 'react';
import type { ColorValue } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { color } from '../theme/tokens';

/**
 * The design's icon set, as SVG paths lifted from the canvas.
 *
 * Hand-rolled rather than pulled from `@expo/vector-icons`: the design's strokes
 * are 1.6–1.8 at a 24-unit box and its shapes (the layered box for Orders, the
 * two-crate lorry for delivery) are not in any icon font. Matching them by
 * picking near-misses from a library would show.
 */
export type IconName =
  | 'bell'
  | 'search'
  | 'chevron-left'
  | 'chevron-right'
  | 'heart'
  | 'heart-filled'
  | 'share'
  | 'bag'
  | 'truck'
  | 'store'
  | 'shield'
  | 'card'
  | 'pin'
  | 'check'
  | 'sliders'
  | 'home'
  | 'grid'
  | 'box'
  | 'user'
  | 'star'
  | 'star-filled'
  | 'phone'
  | 'plus'
  | 'minus'
  | 'x'
  | 'wallet'
  | 'chart'
  | 'arrow-up'
  | 'clock'
  | 'alert';

export interface IconProps {
  name: IconName;
  size?: number;
  /**
   * `ColorValue`, not `string`: React Navigation hands its tab tint through as
   * one, and it can be an opaque platform colour rather than a hex string.
   */
  color?: ColorValue;
  strokeWidth?: number;
}

export function Icon({
  name,
  size = 20,
  color: stroke = color.ink,
  strokeWidth = 1.8,
}: IconProps): React.ReactElement {
  const common: StrokeProps = {
    stroke,
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {render(name, common, stroke)}
    </Svg>
  );
}

interface StrokeProps {
  stroke: ColorValue;
  strokeWidth: number;
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
  fill: 'none';
}

function render(name: IconName, p: StrokeProps, stroke: ColorValue): React.ReactElement | null {
  switch (name) {
    case 'bell':
      return <Path {...p} d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />;
    case 'search':
      return (
        <>
          <Circle cx={11} cy={11} r={7} {...p} />
          <Path {...p} d="M20 20l-3.5-3.5" />
        </>
      );
    case 'chevron-left':
      return <Path {...p} strokeWidth={2} d="M15 5l-7 7 7 7" />;
    case 'chevron-right':
      return <Path {...p} strokeWidth={2} d="M9 5l7 7-7 7" />;
    case 'heart':
      return (
        <Path
          {...p}
          d="M12 20s-7-4.6-7-9.3A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.7C19 15.4 12 20 12 20z"
        />
      );
    case 'heart-filled':
      return (
        <Path
          fill={stroke}
          stroke={stroke}
          strokeWidth={p.strokeWidth}
          strokeLinejoin="round"
          d="M12 20s-7-4.6-7-9.3A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.7C19 15.4 12 20 12 20z"
        />
      );
    case 'share':
      return (
        <>
          <Circle cx={18} cy={5} r={2.4} {...p} strokeWidth={1.7} />
          <Circle cx={6} cy={12} r={2.4} {...p} strokeWidth={1.7} />
          <Circle cx={18} cy={19} r={2.4} {...p} strokeWidth={1.7} />
          <Path {...p} strokeWidth={1.7} d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" />
        </>
      );
    case 'bag':
      return (
        <>
          <Path {...p} d="M5 7h14l-1.2 11.2a2 2 0 01-2 1.8H8.2a2 2 0 01-2-1.8z" />
          <Path {...p} d="M9 7V5.5a3 3 0 016 0V7" />
        </>
      );
    case 'truck':
      return (
        <>
          <Path {...p} strokeWidth={1.6} d="M3 7h11v10H3zM14 10h4l3 3v4h-7z" />
          <Circle cx={7} cy={18} r={1.8} {...p} strokeWidth={1.6} />
          <Circle cx={17.5} cy={18} r={1.8} {...p} strokeWidth={1.6} />
        </>
      );
    case 'store':
      return (
        <>
          <Path {...p} strokeWidth={1.6} d="M4 9l1.5-4h13L20 9M4 9v10h16V9M4 9h16" />
          <Path {...p} strokeWidth={1.6} d="M9.5 13h5" />
        </>
      );
    case 'shield':
      return (
        <>
          <Path
            {...p}
            strokeWidth={1.6}
            d="M12 3l7.5 3v5.5c0 4.4-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5.1-7.5-9.5V6z"
          />
          <Path {...p} strokeWidth={1.6} d="M9 12l2 2 4-4" />
        </>
      );
    case 'card':
      return (
        <Path
          {...p}
          d="M20 7H4a1 1 0 00-1 1v9a1 1 0 001 1h16a1 1 0 001-1V8a1 1 0 00-1-1zM3 11h18M7 15h3"
        />
      );
    case 'pin':
      return (
        <>
          <Path {...p} strokeWidth={1.7} d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z" />
          <Circle cx={12} cy={10} r={2.4} {...p} strokeWidth={1.7} />
        </>
      );
    case 'check':
      return <Path {...p} strokeWidth={2.6} d="M5 12.5l4.5 4.5L19 7.5" />;
    case 'sliders':
      return <Path {...p} strokeWidth={2} d="M4 6h16M7 12h10M10 18h4" />;
    case 'home':
      return <Path {...p} d="M4 10.5L12 4l8 6.5V20h-5v-5.5H9V20H4z" />;
    case 'grid':
      return (
        <>
          <Rect x={4} y={4} width={7} height={7} rx={1.6} {...p} />
          <Rect x={13} y={4} width={7} height={7} rx={1.6} {...p} />
          <Rect x={4} y={13} width={7} height={7} rx={1.6} {...p} />
          <Rect x={13} y={13} width={7} height={7} rx={1.6} {...p} />
        </>
      );
    case 'box':
      return (
        <>
          <Path {...p} d="M4 8l8-4 8 4v8l-8 4-8-4z" />
          <Path {...p} d="M4 8l8 4 8-4M12 12v8" />
        </>
      );
    case 'user':
      return (
        <>
          <Circle cx={12} cy={8.5} r={3.6} {...p} />
          <Path {...p} d="M4.8 20a7.2 7.2 0 0114.4 0" />
        </>
      );
    case 'star':
      return (
        <Path
          {...p}
          strokeWidth={1.6}
          d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z"
        />
      );
    case 'star-filled':
      return (
        <Path
          fill={stroke}
          stroke={stroke}
          strokeWidth={1.2}
          strokeLinejoin="round"
          d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z"
        />
      );
    case 'phone':
      return (
        <Path
          {...p}
          d="M6.5 3h4l1.5 4-2.2 1.6a12 12 0 005.6 5.6L17 12l4 1.5v4a2 2 0 01-2.2 2A17 17 0 014.5 5.2 2 2 0 016.5 3z"
        />
      );
    case 'plus':
      return <Path {...p} strokeWidth={2} d="M12 5v14M5 12h14" />;
    case 'minus':
      return <Path {...p} strokeWidth={2} d="M5 12h14" />;
    case 'x':
      return <Path {...p} strokeWidth={2} d="M6 6l12 12M18 6L6 18" />;
    case 'wallet':
      return (
        <>
          <Path {...p} strokeWidth={1.7} d="M3 8a2 2 0 012-2h12a2 2 0 012 2v1H5a2 2 0 00-2 2z" />
          <Path
            {...p}
            strokeWidth={1.7}
            d="M3 11a2 2 0 012-2h14a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2z"
          />
          <Circle cx={17} cy={14} r={1.2} fill={stroke} stroke="none" />
        </>
      );
    case 'chart':
      return (
        <>
          <Path {...p} strokeWidth={1.7} d="M4 20h16" />
          <Path {...p} strokeWidth={2} d="M7 20v-6M12 20V6M17 20v-9" />
        </>
      );
    case 'arrow-up':
      return <Path {...p} strokeWidth={2} d="M12 19V5M6 11l6-6 6 6" />;
    case 'clock':
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} {...p} strokeWidth={1.7} />
          <Path {...p} strokeWidth={1.7} d="M12 7.5V12l3 1.8" />
        </>
      );
    case 'alert':
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} {...p} strokeWidth={1.7} />
          <Path {...p} strokeWidth={2} d="M12 7.8v5" />
          <Circle cx={12} cy={16.2} r={1} fill={stroke} stroke="none" />
        </>
      );
    default:
      return null;
  }
}
