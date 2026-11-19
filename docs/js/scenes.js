// Scene presets: wall treatments, shelf finishes and lighting rigs, and the named scenes that combine them.
import * as THREE from 'three';

/** Ready-made rooms. Picking one fills in the individual settings, which can then be changed. */
export const SCENES = {
  parlour: { label: 'Classic parlour', wall: 'diamond', wallColor: '#42121c', wood: 'honey',
    lighting: 'soft', style: 'floating', palette: 'classic' },
  library: { label: 'Old library', wall: 'panel', wallColor: '#4a2d1b', wood: 'walnut',
    lighting: 'lamp', style: 'bookcase', palette: 'leather' },
  gallery: { label: 'Modern gallery', wall: 'plain', wallColor: '#e7e4dd', wood: 'white',
    lighting: 'track', style: 'floating', palette: 'vivid' },
  study: { label: 'Cool study', wall: 'stripe', wallColor: '#2c4654', wood: 'walnut',
    lighting: 'window', style: 'floating', palette: 'classic' },
  sunroom: { label: 'Sunlit room', wall: 'plain', wallColor: '#e3d3b8', wood: 'oak',
    lighting: 'golden', style: 'floating', palette: 'classic' },
  evening: { label: 'Evening lamp', wall: 'damask', wallColor: '#17332f', wood: 'walnut',
    lighting: 'lamp', style: 'floating', palette: 'classic' },
};

export const WALLS = {
  diamond: 'Diamond wallpaper',
  damask: 'Damask wallpaper',
  stripe: 'Striped wallpaper',
  plain: 'Painted',
  panel: 'Wood panelling',
};

/** Shelf finishes. tint is the colour the wood grain is pulled towards; grain false means paint. */
export const WOODS = {
  oak: { label: 'Pale oak', tint: '#b98f5e', grain: true, roughness: 0.55 },
  honey: { label: 'Honey oak', tint: '#8a5a33', grain: true, roughness: 0.5 },
  walnut: { label: 'Dark walnut', tint: '#46291a', grain: true, roughness: 0.45 },
  white: { label: 'White', tint: '#e9e6e0', grain: false, roughness: 0.5 },
  black: { label: 'Black', tint: '#171615', grain: false, roughness: 0.4 },
};

const v = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Lighting rigs. g describes the shelf: centre (Vector3), halfW, halfH, distance (camera to wall),
 * radius (of a sphere around everything), topY.
 * Each spot: pos, target (Vector3), color [r,g,b], intensity, cover (radius lit at the target, metres),
 * penumbra (0 hard edge .. 1 fades from the centre), soft (shadow softness), gobo (optional 'window').
 */
export const LIGHTING = {
  soft: {
    label: 'Soft daylight',
    exposure: 0.9, vignette: 0.18, ambient: 0.07, reflections: 0.3,
    sky: { color: [0.86, 0.9, 1.0], intensity: 1.05 },
    spots: (g) => [{
      pos: g.centre.clone().add(v(-0.55, 0.85, 1.0).multiplyScalar(g.distance)),
      target: g.centre.clone(),
      color: [1.0, 0.93, 0.84], intensity: 3.3, cover: g.radius * 2.2, penumbra: 0.5, soft: 0.1,
    }],
  },
  track: {
    label: 'Gallery spotlights',
    exposure: 0.92, vignette: 0.1, ambient: 0.12, reflections: 0.4,
    sky: { color: [0.95, 0.97, 1.0], intensity: 0.75 },
    spots: (g) => {
      const count = Math.max(2, Math.min(4, Math.round((g.halfW * 2) / 0.85)));
      const spacing = (g.halfW * 2) / count;
      const drop = g.halfH * 2;
      return [...Array(count).keys()].map((i) => {
        const x = -g.halfW + spacing * (i + 0.5);
        return {
          pos: v(x, g.topY + 0.55 + drop * 0.3, 0.75 + drop * 0.45),
          target: v(x, g.centre.y - g.halfH * 0.15, 0.1),
          color: [1.0, 0.96, 0.9], intensity: 3.6,
          cover: Math.max(spacing * 0.8, drop * 0.62), penumbra: 0.7, soft: 0.035,
        };
      });
    },
  },
  lamp: {
    label: 'Warm lamp',
    exposure: 1.12, vignette: 0.45, ambient: 0.045, reflections: 0.18,
    sky: { color: [1.0, 0.82, 0.62], intensity: 0.32 },
    spots: (g) => [{
      pos: g.centre.clone().add(v(0.45, 0.4, 0.72).multiplyScalar(g.distance)),
      target: g.centre.clone().add(v(g.halfW * 0.1, g.halfH * 0.1, 0)),
      color: [1.0, 0.84, 0.64], intensity: 4.6, cover: g.radius * 1.15, penumbra: 1.0, soft: 0.05,
    }],
  },
  window: {
    label: 'Window light',
    exposure: 0.95, vignette: 0.22, ambient: 0.09, reflections: 0.3,
    sky: { color: [0.8, 0.88, 1.0], intensity: 0.95 },
    spots: (g) => [{
      pos: g.centre.clone().add(v(-0.95, 0.42, 0.85).multiplyScalar(g.distance)),
      target: g.centre.clone().add(v(g.halfW * 0.05, 0, 0)),
      color: [0.93, 0.96, 1.0], intensity: 4.4, cover: g.radius * 1.45, penumbra: 0.15, soft: 0.014,
      gobo: 'window',
    }],
  },
  golden: {
    label: 'Golden hour',
    exposure: 1.0, vignette: 0.28, ambient: 0.07, reflections: 0.25,
    sky: { color: [0.66, 0.76, 1.0], intensity: 0.7 },
    spots: (g) => [{
      pos: g.centre.clone().add(v(1.05, 0.2, 0.75).multiplyScalar(g.distance)),
      target: g.centre.clone().add(v(-g.halfW * 0.05, 0, 0)),
      color: [1.0, 0.84, 0.62], intensity: 3.6, cover: g.radius * 1.5, penumbra: 0.15, soft: 0.012,
      gobo: 'window',
    }],
  },
};
