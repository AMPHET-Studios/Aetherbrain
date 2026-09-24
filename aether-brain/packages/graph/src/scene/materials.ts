import { AdditiveBlending, Color, DoubleSide, NormalBlending, ShaderMaterial, Vector3 } from 'three'

/**
 * Neuron core: instanced sphere with fresnel rim + HDR output so bloom picks
 * it up selectively (edges and stars stay below the luminance threshold).
 * Per-instance color comes from `instanceColor` (three injects the attribute).
 * The alpha channel of the color is packed into `aGlow` (extra attribute):
 *   x = glow multiplier (1 = idle, ~2.4 = selected), y = dim (0..1), z = pulse phase
 */
export function createNodeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aGlow;
      varying vec3 vColor;
      varying vec3 vGlow;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vec4 mvPosition = vec4(position, 1.0);
        vec3 nrm = normal;
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vec4 worldPos = modelMatrix * mvPosition;
        vec4 viewPos = viewMatrix * worldPos;
        vNormalW = normalize(mat3(modelMatrix) * nrm);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif
        vGlow = aGlow;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vColor;
      varying vec3 vGlow;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        float ndv = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);
        float fresnel = pow(1.0 - ndv, 2.2);
        float pulse = 0.5 + 0.5 * sin(uTime * 2.4 + vGlow.z);
        float glow = vGlow.x;
        float dim = vGlow.y;
        // core: dense center, brighter rim; selected nodes pulse.
        vec3 core = vColor * (0.55 + 0.45 * ndv);
        vec3 rim = vColor * fresnel * 1.6 + vec3(1.0) * pow(fresnel, 5.0) * 0.5;
        vec3 col = (core + rim) * glow * (1.0 + 0.18 * pulse * step(1.5, glow));
        col = mix(col * 0.12, col, dim);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: false,
    depthWrite: true,
  })
}

/**
 * Soft additive halo billboard around each neuron. Instanced planes; the
 * vertex shader re-expands the quad in view space so it always faces the
 * camera. Kept below bloom threshold so the "aura" is soft, not smeared.
 */
export function createHaloMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 aGlow;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec3 vGlow;
      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif
        vGlow = aGlow;
        vec3 center = vec3(0.0);
        float scale = 1.0;
        #ifdef USE_INSTANCING
          center = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          scale = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
        #endif
        vec4 viewCenter = viewMatrix * modelMatrix * vec4(center, 1.0);
        viewCenter.xy += position.xy * scale;
        gl_Position = projectionMatrix * viewCenter;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec3 vGlow;
      void main() {
        vec2 p = vUv - 0.5;
        float d = length(p) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        a = a * a * a;
        float pulse = 0.5 + 0.5 * sin(uTime * 2.4 + vGlow.z);
        float glow = vGlow.x;
        float strength = 0.42 * a * (0.5 + 0.5 * min(glow, 2.0)) * (1.0 + 0.3 * pulse * step(1.5, glow));
        strength *= mix(0.05, 1.0, vGlow.y);
        gl_FragColor = vec4(vColor * strength, strength);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
}

/**
 * Synapses: one LineSegments draw call for every edge. Per-vertex color,
 * a `aT` (0 → 1 along the segment) for travelling pulses, and `aHi` for
 * highlight weight so edges of the selected neuron light up.
 */
export function createEdgeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBase: { value: 0.36 },
      uFogColor: { value: new Color('#04050d') },
      uFogDensity: { value: 0.0028 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aT;
      attribute float aHi;
      varying vec3 vColor;
      varying float vT;
      varying float vHi;
      varying float vDepth;
      void main() {
        vColor = aColor;
        vT = aT;
        vHi = aHi;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBase;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying vec3 vColor;
      varying float vT;
      varying float vHi;
      varying float vDepth;
      void main() {
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
        float dim = mix(1.0, 0.18, step(vHi, -0.5));
        float hi = max(vHi, 0.0);
        // travelling signal along highlighted synapses
        float p = fract(vT - uTime * 0.45);
        float spark = smoothstep(0.80, 1.0, p) * hi;
        float alpha = uBase * dim * (1.0 + 1.3 * hi) + spark * 0.6;
        vec3 col = vColor * (0.7 + 0.45 * hi) + vec3(1.0) * spark * 0.25;
        col = mix(col, uFogColor, fog * 0.6);
        gl_FragColor = vec4(col * alpha, alpha * (1.0 - fog * 0.5));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
}

/** Starfield points, cheap and dim so they never bloom. */
export function createStarMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      varying float vPhase;
      void main() {
        vPhase = aPhase;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying float vPhase;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p) * 2.0;
        float a = smoothstep(1.0, 0.2, d);
        float tw = 0.6 + 0.4 * sin(uTime * 0.8 + vPhase);
        vec3 col = mix(vec3(0.55, 0.62, 0.95), vec3(0.95, 0.9, 1.0), vPhase / 6.283);
        gl_FragColor = vec4(col * a * tw * 0.55, a * tw * 0.55);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
}

/** Translucent tag "field" — a soft sphere around a tag's centroid. */
export function createFieldMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: { value: color }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        float ndv = abs(dot(normalize(vNormalW), normalize(vViewDir)));
        float rim = pow(1.0 - ndv, 3.0);
        float a = 0.035 + rim * 0.22 * (0.85 + 0.15 * sin(uTime * 1.3));
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
}

export const NEBULA_COLORS = [new Color('#1c1650'), new Color('#0b2d4a'), new Color('#2b0f3a')]

/** Big soft additive discs far away — a cheap nebula haze. */
export function createNebulaMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: { value: color } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 viewCenter = viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float s = length(vec3(modelMatrix[0][0], modelMatrix[0][1], modelMatrix[0][2]));
        viewCenter.xy += position.xy * s;
        gl_Position = projectionMatrix * viewCenter;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv - 0.5;
        float d = length(p) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        a = a * a * 0.35;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
  })
}

export const _v3 = new Vector3()
