/**
 * Whether the 3D view draws its frames. Never while a full-window panel covers it (`covered`: the Boards view, the Projects board: a
 * covered scene is paid for by whatever runs on top of it and seen by nobody), never while it rests behind a viewer reading the layout
 * (`restBehind`, the Unreal companion) and its window is not the one in front; otherwise every frame.
 */
export function frameloopFor(state: { covered: boolean; restBehind: boolean; front: boolean }): 'always' | 'never' {
  return state.covered || (state.restBehind && !state.front) ? 'never' : 'always'
}
