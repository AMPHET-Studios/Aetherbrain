/**
 * GLSL for the sky: pure strings, no imports, so the same text runs in the app, in a preview harness and in tests that
 * read it. `SKY_COLOR_GLSL` is one function, `skyColor(dir)`: the colour (linear light, under `SKY_MAX_LINEAR`) of the
 * sky in a direction. It is evaluated once per texel when the sky is baked into a cube map; the dome then only samples it.
 *
 * What it paints, back to front: a faint blue-violet airglow, four emission nebulae (rose, teal, violet, gold: ridged
 * filaments over a soft body, the domain warped so no two clouds look alike), two distant galaxies, and the Milky Way:
 * a band that wobbles in width, a warm bulge at the galactic centre, clumps of cloud along it, a dark dust lane down
 * its middle and a grain of unresolved stars. The crisp stars are real points (see `skyData.ts`), not this.
 */

export const SKY_NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i + vec3(0.0, 0.0, 0.0)), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 6; i++) {
      s += a * noise3(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return s;
  }
  float ridged(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 5; i++) {
      float n = 1.0 - abs(noise3(p) * 2.0 - 1.0);
      s += a * n * n;
      p = p * 2.1 + 5.3;
      a *= 0.5;
    }
    return s;
  }
  vec3 warp(vec3 p, float k) {
    return p + k * vec3(fbm(p + 1.7), fbm(p + 8.3), fbm(p + 4.1));
  }
`

export const SKY_COLOR_GLSL = /* glsl */ `
  uniform vec3 uN;
  uniform vec3 uC;
  uniform vec3 uNebDir[4];
  uniform vec3 uNebCol[4];
  uniform float uNebRad[4];
  uniform vec3 uGalDir[2];
  uniform vec3 uGalShape[2];
  uniform vec3 uGalCol[2];
  uniform float uGain;

  // A distant galaxy: a smudge on the sky, bright heart, a hint of arms. dir is the lookup, g the galaxy's index.
  vec3 distantGalaxy(vec3 dir, vec3 gd, vec3 shape, vec3 col) {
    float facing = dot(dir, gd);
    if (facing < 0.9) return vec3(0.0);
    vec3 up = abs(gd.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t1 = normalize(cross(gd, up));
    vec3 t2 = cross(gd, t1);
    vec2 q = vec2(dot(dir, t1), dot(dir, t2));
    float ca = cos(shape.z);
    float sa = sin(shape.z);
    q = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    q.y /= max(0.12, 1.0 - 0.88 * shape.y);
    float r = length(q) / shape.x;
    float disc = exp(-r * r * 2.6);
    float core = exp(-r * r * 38.0);
    float arms = 0.65 + 0.35 * sin(atan(q.y, q.x) * 2.0 + r * 9.0);
    return col * (disc * 0.16 * arms + core * 0.42);
  }

  vec3 skyColor(vec3 dir) {
    vec3 c = vec3(0.0);

    // Airglow: the faintest blue-violet wash, brighter in patches.
    c += vec3(0.0028, 0.0042, 0.0105) * (0.35 + fbm(dir * 1.4 + 3.0));

    // Emission nebulae.
    for (int i = 0; i < 4; i++) {
      float ang = acos(clamp(dot(dir, uNebDir[i]), -1.0, 1.0));
      // A ragged edge: the reach of the cloud wobbles with the noise, so it is never a round blob.
      float reach = uNebRad[i] * (0.62 + 0.7 * fbm(dir * 2.3 + float(i) * 7.1));
      float fall = smoothstep(reach, 0.0, ang);
      if (fall <= 0.0) continue;
      vec3 p = warp(dir * (2.6 + float(i) * 0.7) + float(i) * 13.7, 0.9);
      float body = fbm(p * 1.7);
      float fil = ridged(p * 2.5);
      float dens = pow(fall, 1.35) * (0.75 * body * body + 0.55 * fil * fil);
      c += uNebCol[i] * dens * 0.5;
      // A hotter core in the thick of it.
      c += uNebCol[i] * 0.5 * pow(fall, 3.0) * smoothstep(0.55, 1.0, fil) * 0.28;
    }

    // Distant galaxies.
    c += distantGalaxy(dir, uGalDir[0], uGalShape[0], uGalCol[0]);
    c += distantGalaxy(dir, uGalDir[1], uGalShape[1], uGalCol[1]);

    // The Milky Way.
    vec3 B = cross(uN, uC);
    float lat = dot(dir, uN);
    float lon = atan(dot(dir, B), dot(dir, uC));
    float width = 0.2 + 0.07 * fbm(dir * 2.2 + 5.0);
    float band = exp(-(lat * lat) / (width * width));
    float coreAng = acos(clamp(dot(dir, uC), -1.0, 1.0));
    float bulge = exp(-pow(coreAng / 0.75, 2.0));
    vec3 w = warp(dir * 3.4, 0.7);
    float cloud = fbm(w * 1.9);
    float clumps = smoothstep(0.22, 0.8, cloud);
    float rift = exp(-pow((lat - 0.015 + 0.035 * sin(lon * 2.0 + 1.3)) / 0.05, 2.0));
    float dust = rift * smoothstep(0.28, 0.72, fbm(w * 3.1 + 1.0));
    float mw = band * (0.25 + 0.75 * clumps) * (0.45 + 1.5 * bulge);
    mw = pow(mw, 1.2) * (1.0 - 0.88 * dust);
    vec3 mwCol = mix(vec3(0.5, 0.6, 0.98), vec3(1.0, 0.8, 0.54), smoothstep(0.0, 0.85, bulge));
    c += mwCol * mw * 0.26;
    // A mottled glow of stars too faint to resolve (the sharp ones are real points, see skyData.ts).
    c += mwCol * band * (1.0 - 0.7 * dust) * 0.07 * smoothstep(0.4, 0.78, fbm(dir * 38.0 + 2.0));

    return min(c * uGain, vec3(0.6));
  }
`

/** Vertex shader of the bake: the unit box's corner is the direction. */
export const SKY_BAKE_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const SKY_BAKE_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  ${SKY_NOISE_GLSL}
  ${SKY_COLOR_GLSL}
  void main() {
    gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
  }
`

/**
 * The dome: a unit box that is drawn at the far plane whatever the camera does (`.xyww`: depth is exactly 1), turning
 * with the view but never moving with it. It samples the baked cube map and dithers by a hair so the slow dark
 * gradients do not band once the display encodes them.
 */
export const SKY_DOME_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * mat3(modelMatrix) * position, 1.0);
    gl_Position = p.xyww;
  }
`

export const SKY_DOME_FRAGMENT = /* glsl */ `
  uniform samplerCube uSky;
  uniform float uGain;
  varying vec3 vDir;
  float dither(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
  void main() {
    vec3 col = textureCube(uSky, normalize(vDir)).rgb * uGain;
    col += (dither(gl_FragCoord.xy) - 0.5) / 255.0 * 0.5;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
    #include <colorspace_fragment>
  }
`
