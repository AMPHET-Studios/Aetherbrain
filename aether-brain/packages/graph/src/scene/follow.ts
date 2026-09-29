import type { Vector3 } from 'three'

/** The part of camera-controls the follow camera uses. */
export interface FollowControls {
  getTarget(out: Vector3, receiveEndValue?: boolean): Vector3
  moveTo(x: number, y: number, z: number, enableTransition?: boolean): Promise<void>
}

/**
 * Move the camera's look-at point by (dx, dy, dz) as one rigid step, so an
 * orbiting node stays where it is on screen, without cutting short a
 * transition that is still running (a flyTo, the user's pan).
 *
 * camera-controls parks a 'rest' listener for every transition it starts and
 * releases them only when the camera comes to rest, which never happens while
 * it chases an orbiting planet: a transition per frame piles up thousands of
 * listeners and resolving them freezes the page. So the step itself is
 * instant (the current point and its goal move together), and only a running
 * transition gets its goal moved by the same amount. `cur` and `end` are
 * scratch vectors.
 */
export function shiftTarget(c: FollowControls, dx: number, dy: number, dz: number, cur: Vector3, end: Vector3): void {
  c.getTarget(cur, false)
  c.getTarget(end, true)
  const moving = !cur.equals(end)
  void c.moveTo(cur.x + dx, cur.y + dy, cur.z + dz, false)
  if (moving) void c.moveTo(end.x + dx, end.y + dy, end.z + dz, true)
}
