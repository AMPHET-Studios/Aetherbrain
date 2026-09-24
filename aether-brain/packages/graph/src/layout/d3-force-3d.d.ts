/**
 * Minimal typings for d3-force-3d (the package ships no types).
 * Only the surface Aether Brain uses is declared; everything is 3D (x/y/z).
 */
declare module 'd3-force-3d' {
  export interface SimNode {
    index?: number
    x: number
    y: number
    z: number
    vx?: number
    vy?: number
    vz?: number
    fx?: number | null
    fy?: number | null
    fz?: number | null
  }

  export interface SimLink<N extends SimNode = SimNode> {
    source: N | number | string
    target: N | number | string
    index?: number
  }

  export interface Force<N extends SimNode> {
    (alpha: number): void
    initialize?(nodes: N[], random?: () => number): void
  }

  export interface Simulation<N extends SimNode, L extends SimLink<N>> {
    restart(): this
    stop(): this
    tick(iterations?: number): this
    nodes(): N[]
    nodes(nodes: N[]): this
    alpha(): number
    alpha(alpha: number): this
    alphaMin(): number
    alphaMin(min: number): this
    alphaDecay(): number
    alphaDecay(decay: number): this
    alphaTarget(): number
    alphaTarget(target: number): this
    velocityDecay(): number
    velocityDecay(decay: number): this
    numDimensions(): number
    numDimensions(n: number): this
    force(name: string): Force<N> | undefined
    force(name: string, force: Force<N> | null): this
    find(x: number, y: number, z?: number, radius?: number): N | undefined
    on(typenames: string, listener: null | ((this: this) => void)): this
    randomSource(source: () => number): this
  }

  export function forceSimulation<N extends SimNode, L extends SimLink<N> = SimLink<N>>(
    nodes?: N[],
    numDimensions?: number,
  ): Simulation<N, L>

  export interface ForceLink<N extends SimNode, L extends SimLink<N>> extends Force<N> {
    links(): L[]
    links(links: L[]): this
    id(fn: (node: N, i: number, nodes: N[]) => string | number): this
    distance(d: number | ((link: L, i: number, links: L[]) => number)): this
    strength(s: number | ((link: L, i: number, links: L[]) => number)): this
    iterations(n: number): this
  }
  export function forceLink<N extends SimNode, L extends SimLink<N> = SimLink<N>>(links?: L[]): ForceLink<N, L>

  export interface ForceManyBody<N extends SimNode> extends Force<N> {
    strength(s: number | ((node: N, i: number, nodes: N[]) => number)): this
    theta(t: number): this
    distanceMin(d: number): this
    distanceMax(d: number): this
  }
  export function forceManyBody<N extends SimNode>(): ForceManyBody<N>

  export interface ForceCenter<N extends SimNode> extends Force<N> {
    x(x: number): this
    y(y: number): this
    z(z: number): this
    strength(s: number): this
  }
  export function forceCenter<N extends SimNode>(x?: number, y?: number, z?: number): ForceCenter<N>

  export interface ForceCollide<N extends SimNode> extends Force<N> {
    radius(r: number | ((node: N, i: number, nodes: N[]) => number)): this
    strength(s: number): this
    iterations(n: number): this
  }
  export function forceCollide<N extends SimNode>(radius?: number | ((node: N) => number)): ForceCollide<N>

  export interface ForceAxis<N extends SimNode> extends Force<N> {
    strength(s: number | ((node: N, i: number, nodes: N[]) => number)): this
    x?(x: number | ((node: N, i: number, nodes: N[]) => number)): this
    y?(y: number | ((node: N, i: number, nodes: N[]) => number)): this
    z?(z: number | ((node: N, i: number, nodes: N[]) => number)): this
  }
  export function forceX<N extends SimNode>(x?: number | ((node: N, i: number, nodes: N[]) => number)): ForceAxis<N>
  export function forceY<N extends SimNode>(y?: number | ((node: N, i: number, nodes: N[]) => number)): ForceAxis<N>
  export function forceZ<N extends SimNode>(z?: number | ((node: N, i: number, nodes: N[]) => number)): ForceAxis<N>

  export interface ForceRadial<N extends SimNode> extends Force<N> {
    radius(r: number | ((node: N, i: number, nodes: N[]) => number)): this
    strength(s: number | ((node: N, i: number, nodes: N[]) => number)): this
    x(x: number): this
    y(y: number): this
    z(z: number): this
  }
  export function forceRadial<N extends SimNode>(
    radius: number | ((node: N, i: number, nodes: N[]) => number),
    x?: number,
    y?: number,
    z?: number,
  ): ForceRadial<N>
}
