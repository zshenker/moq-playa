/**
 * Orders a warm-start group head ahead of the live tail of the same group.
 *
 * A warm-start fill (draft-22 §3.4) or Joining FETCH (draft-16 §9.16.2)
 * delivers the current group's head on its own stream while the subscription
 * delivers the rest of the group, so live objects can arrive before the head.
 * CMAF and LOCMAF need a group's objects in order: MSE drops video after a
 * missing frame until the next keyframe, the assembler rebases each track on
 * its first fragment, and a LOCMAF delta needs the object before it.
 *
 * One instance per track. Objects are released in (group, object) order from
 * object 0 of the head group: the Largest Object's group from SUBSCRIBE_OK,
 * which the fill or Joining FETCH covers. When the head fetch ends, or the wait
 * deadline passes, everything held is released in order and later objects
 * pass straight through.
 *
 * @see draft-ietf-moq-transport-22 §3.4 (fill fetch streams)
 * @see draft-einarsson-moq-locmaf-01 §3 (in-group delta headers)
 * @module
 */
import { ObjectStatus, type MoqtObject } from '@openmoq/transport';

/** Longest wait for the head before held objects are released anyway. */
export const WARM_START_HEAD_WAIT_US = 1_000_000;

export class WarmStartHead {
  private readonly held = new Map<string, MoqtObject>();
  private readonly deadlineUs: number;
  private next: { group: bigint; object: bigint } | null = null;
  private released = false;
  private headGroup: bigint | null = null;
  private passthrough = false;

  constructor(nowUs: number, maxWaitUs: number = WARM_START_HEAD_WAIT_US) {
    this.deadlineUs = nowUs + maxWaitUs;
  }

  /**
   * Set the head group from SUBSCRIBE_OK's Largest Object. Without one the
   * track has no content yet, so no head is coming and objects pass through.
   */
  setHeadGroup(group: bigint | null): void {
    if (this.released) return;
    if (group === null) {
      this.passthrough = true;
      return;
    }
    this.headGroup = group;
    this.next = { group, object: 0n };
  }

  /** Whether objects now pass straight through. */
  get done(): boolean {
    return this.passthrough;
  }

  /**
   * Take one object and return those ready for delivery, in order.
   * @param headOpen whether the fetch delivering the head is still open
   */
  push(obj: MoqtObject, nowUs: number, headOpen: boolean): MoqtObject[] {
    if (this.passthrough) return [obj];
    const group = BigInt(obj.groupId);
    const object = BigInt(obj.objectId);
    const key = `${group}:${object}`;
    if (!this.held.has(key)) this.held.set(key, obj);
    if (!this.released && this.headGroup === null) {
      // Head group unknown: fall back to object 0 of the earliest group seen.
      if (this.next === null || group < this.next.group) this.next = { group, object: 0n };
    }

    const out: MoqtObject[] = [];
    while (this.next !== null) {
      const ready = this.held.get(`${this.next.group}:${this.next.object}`);
      if (ready === undefined) break;
      this.held.delete(`${this.next.group}:${this.next.object}`);
      out.push(ready);
      this.released = true;
      this.next = ready.kind === 'gap' && ready.status === ObjectStatus.END_OF_GROUP
        ? { group: this.next.group + 1n, object: 0n }
        : { group: this.next.group, object: this.next.object + 1n };
    }

    if (!headOpen || nowUs >= this.deadlineUs) out.push(...this.drain());
    return out;
  }

  /** Release everything held, in order, and pass later objects through. */
  drain(): MoqtObject[] {
    this.passthrough = true;
    const rest = [...this.held.values()].sort((a, b) => {
      const ga = BigInt(a.groupId);
      const gb = BigInt(b.groupId);
      if (ga !== gb) return ga < gb ? -1 : 1;
      const oa = BigInt(a.objectId);
      const ob = BigInt(b.objectId);
      return oa < ob ? -1 : oa > ob ? 1 : 0;
    });
    this.held.clear();
    return rest;
  }
}
