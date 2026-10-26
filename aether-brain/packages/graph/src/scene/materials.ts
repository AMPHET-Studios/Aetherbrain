import { AdditiveBlending, Color, DoubleSide, NormalBlending, ShaderMaterial, Vector3 } from 'three'

/**
 * Neuron core: instanced sphere with fresnel rim + HDR output so bloom picks
 * it up selectively (edges and stars stay below the luminance threshold).
 * Per-instance color comes from `instanceColor` (three injects the attribute).
 * The alpha channel of the color is packed into `aGlow` (extra attribute):
 *   x = glow multiplier (1 = idle, ~2.4 = selected), y = dim (0..1), z = pulse phase,
 *   w = 1 for a solid body (a planet: lit sphere, no bloom), 0 for a glowing neuron or star
 */
export function createNodeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aGlow;
      attribute vec4 aLight;
      varying vec3 vColor;
      varying vec4 vGlow;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vObj;
      varying vec4 vLight;
      void main() {
        vObj = position;
        vLight = aLight;
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
      varying vec4 vGlow;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vObj;
      varying vec4 vLight;

      // A rocky surface for solid bodies: value-noise fbm for continents and maria, a second fine layer for grain, and round craters.
      float hash3(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 i = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
          mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
          f.z
        );
      }
      float fbm(vec3 p) {
        float a = 0.5;
        float s = 0.0;
        for (int k = 0; k < 4; k++) {
          s += a * vnoise(p);
          p = p * 2.03 + 11.7;
          a *= 0.5;
        }
        return s;
      }
      float craters(vec3 p) {
        vec3 c = floor(p);
        float best = 0.0;
        for (int x = -1; x <= 1; x++) {
          for (int y = -1; y <= 1; y++) {
            for (int z = -1; z <= 1; z++) {
              vec3 g = c + vec3(float(x), float(y), float(z));
              float h = hash3(g);
              if (h < 0.55) continue;
              vec3 centre = g + vec3(hash3(g + 3.1), hash3(g + 7.7), hash3(g + 1.3));
              float d = length(p - centre) / (0.18 + 0.22 * h);
              best = max(best, smoothstep(1.0, 0.8, d) * 0.5 - smoothstep(0.8, 0.55, d) * 0.5 + smoothstep(1.0, 0.9, d) * smoothstep(0.7, 0.9, d) * 0.35);
            }
          }
        }
        return best;
      }
      void main() {
        vec3 nrm = normalize(vNormalW);
        vec3 view = normalize(vViewDir);
        float ndv = clamp(dot(nrm, view), 0.0, 1.0);
        float fresnel = pow(1.0 - ndv, 2.2);
        float pulse = 0.5 + 0.5 * sin(uTime * 2.4 + vGlow.z);
        float glow = vGlow.x;
        float dim = vGlow.y;
        // core: dense center, brighter rim; selected nodes pulse.
        vec3 core = vColor * (0.55 + 0.45 * ndv);
        vec3 rim = vColor * fresnel * 1.6 + vec3(1.0) * pow(fresnel, 5.0) * 0.5;
        vec3 col = (core + rim) * glow * (1.0 + 0.18 * pulse * step(1.5, glow));
        // Solid body (planet): lit from above the viewer, a thin atmosphere, stays under the bloom threshold.
        // Lit from its own star (aLight points from the body to it); a body with no star is lit from above.
        vec3 L = length(vLight.xyz) > 0.01 ? normalize(vLight.xyz) : vec3(0.0, 1.0, 0.0);
        float lit = smoothstep(-0.06, 0.55, dot(nrm, L));
        vec3 q = vObj * 2.2 + vGlow.z * 3.7;
        float terrain = fbm(q);
        float grain = vnoise(vObj * 14.0 + vGlow.z);
        float crater = craters(vObj * 3.0 + vGlow.z * 5.0);
        float tone = 0.55 + 0.9 * terrain + 0.12 * grain + 0.35 * crater;
        // The tint of the file (its area, its folder) stays, but as rock: halfway to a warm grey.
        vec3 rock = mix(vec3(0.46, 0.42, 0.38), vColor, 0.5) * tone;
        // Life follows use: an unused body stays dry, grey rock; one you open and write in grows oceans, green land and an air of its own.
        float life = clamp(vLight.w, 0.0, 1.0);
        float sea = smoothstep(0.52, 0.46, terrain);
        vec3 wet = mix(vec3(0.22, 0.42, 0.2) * (0.6 + 0.8 * terrain), vec3(0.06, 0.24, 0.6), sea);
        rock = mix(rock, wet, life * 0.85);
        fresnel *= 1.0 + 2.5 * life;
        vec3 body = (rock * (0.07 + 1.0 * lit) + mix(vColor, vec3(0.4, 0.65, 1.0), life) * fresnel * (0.3 + 0.5 * life) * lit) * glow;
        col = mix(col, body, vGlow.w);
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
      attribute vec4 aGlow;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec4 vGlow;
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
      varying vec4 vGlow;
      void main() {
        vec2 p = vUv - 0.5;
        float d = length(p) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        a = a * a * a;
        float pulse = 0.5 + 0.5 * sin(uTime * 2.4 + vGlow.z);
        float glow = vGlow.x;
        float strength = 0.42 * a * (0.5 + 0.5 * min(glow, 2.0)) * (1.0 + 0.3 * pulse * step(1.5, glow));
        strength *= mix(0.05, 1.0, vGlow.y);
        // Solid bodies only get a faint atmosphere.
        strength *= mix(1.0, 0.35, vGlow.w);
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

/**
 * Orbit rings: one instanced LineSegments for every ring of the system layout.
 * The geometry is a unit circle in the XZ plane; per instance: `iCenter` (the
 * parent's live position), `iRadius`, `iQuat` (orbit plane), `iColor`, `iAlpha`.
 */
export function createRingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uFogDensity: { value: 0.00035 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iCenter;
      attribute float iRadius;
      attribute vec4 iQuat;
      attribute vec3 iColor;
      attribute float iAlpha;
      uniform float uFogDensity;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec3 v = position * iRadius;
        vec3 t = 2.0 * cross(iQuat.xyz, v);
        vec3 p = iCenter + v + iQuat.w * t + cross(iQuat.xyz, t);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * mv.z * mv.z);
        vColor = iColor;
        vAlpha = iAlpha * (1.0 - 0.75 * fog);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(vColor * vAlpha, vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
}

/**
 * Picture thumbnails: one instanced camera-facing quad per image moon that
 * has a picture, all sampling one texture array. Per instance: `iCenter` (the
 * node's live position), `iSize` (quad width), `iLayer` (texture layer) and
 * `iAlpha` (the node's dim state, so filters and focus dim pictures too). A
 * dimmed picture darkens the way the cores do instead of turning see-through:
 * the node's shrunken core sits right behind it and would show through. The
 * quad is a rounded square with a thin bright rim, so a picture reads as a
 * framed moon; it sits a little toward the camera so that core stays hidden.
 * Rows were written top-first (canvas order), hence v is flipped. No fog, and
 * every output stays under the bloom threshold. `colorspace_fragment`
 * encodes for the screen when drawn straight to it and is a no-op into the
 * bloom composer's linear buffer.
 */
export function createThumbMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uMap: { value: null } },
    vertexShader: /* glsl */ `
      attribute vec3 iCenter;
      attribute float iSize;
      attribute float iLayer;
      attribute float iAlpha;
      attribute float iFade;
      attribute float iVideo;
      varying vec2 vUv;
      varying float vLayer;
      varying float vAlpha;
      varying float vFade;
      varying float vVideo;
      void main() {
        vUv = uv;
        vLayer = iLayer;
        vAlpha = iAlpha;
        vFade = iFade;
        vVideo = iVideo;
        vec4 viewCenter = viewMatrix * modelMatrix * vec4(iCenter, 1.0);
        viewCenter.xy += position.xy * iSize;
        viewCenter.z += iSize * 0.2;
        gl_Position = projectionMatrix * viewCenter;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2DArray uMap;
      varying vec2 vUv;
      varying float vLayer;
      varying float vAlpha;
      varying float vFade;
      varying float vVideo;
      // 4×4 ordered dither threshold in (0, 1) for this pixel.
      float bayer4(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        // The 2×2 Bayer matrix [0 2; 3 1] at the fine and the coarse level.
        vec2 f = mod(q, 2.0);
        vec2 c = floor(q / 2.0);
        float fine = 2.0 * f.x + 3.0 * f.y - 4.0 * f.x * f.y;
        float coarse = 2.0 * c.x + 3.0 * c.y - 4.0 * c.x * c.y;
        return (fine * 4.0 + coarse + 0.5) / 16.0;
      }
      // Signed distance to a rounded square of half-size b, corner radius r (negative inside).
      float roundedBox(vec2 p, float b, float r) {
        vec2 q = abs(p) - vec2(b - r);
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }
      void main() {
        float d = roundedBox(vUv - 0.5, 0.5, 0.12);
        float aa = max(fwidth(d), 1e-4);
        float mask = 1.0 - smoothstep(-aa, 0.0, d);
        // A card the camera is passing fades by dropping pixels, not by blending: the pixels kept
        // write depth as solid ones, so nothing behind a nearly gone card is cut out.
        if (mask < 0.01 || vFade < bayer4(gl_FragCoord.xy)) discard;
        vec3 pic = texture(uMap, vec3(vUv.x, 1.0 - vUv.y, vLayer)).rgb;
        vec3 col = pic * 0.94;
        // A video's still: a play badge in the middle (a dark disc, a white triangle). It never plays here.
        if (vVideo > 0.5) {
          vec2 p = vUv - 0.5;
          float r = length(p);
          float raa = max(fwidth(r), 1e-4);
          float disc = 1.0 - smoothstep(0.15 - raa, 0.15, r);
          col = mix(col, vec3(0.03, 0.04, 0.08), disc * 0.6);
          vec2 q = p - vec2(0.01, 0.0);
          float tri = max(-q.x - 0.05, abs(q.y) * 1.923 + q.x - 0.075);
          float taa = max(fwidth(tri), 1e-4);
          col = mix(col, vec3(0.96), 1.0 - smoothstep(-taa, 0.0, tri));
        }
        float rim = 1.0 - smoothstep(0.02, 0.02 + aa * 1.5, -d);
        col = mix(col, vec3(0.78, 0.8, 0.9), rim) * mix(0.12, 1.0, vAlpha);
        gl_FragColor = vec4(col, mask);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: true,
    depthTest: true,
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
