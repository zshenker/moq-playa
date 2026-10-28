import { describe, it, expect } from 'vitest';
import { ObjectStatus, varint, type MoqtObject } from '@openmoq/transport';
import { WarmStartHead } from './warm-start-head.js';

function data(group: number, object: number): MoqtObject {
  return {
    kind: 'data', trackAlias: varint(1), groupId: varint(group), subgroupId: varint(0),
    objectId: varint(object), publisherPriority: 128, extensions: undefined, payload: new Uint8Array([group, object]),
  } as MoqtObject;
}

function endOfGroup(group: number, object: number): MoqtObject {
  return {
    kind: 'gap', trackAlias: varint(1), groupId: varint(group), subgroupId: varint(0),
    objectId: varint(object), status: ObjectStatus.END_OF_GROUP,
  } as MoqtObject;
}

const ids = (objs: MoqtObject[]) => objs.map((o) => `${o.groupId}:${o.objectId}`);

describe('WarmStartHead', () => {
  it('holds a live tail that arrives before the head and releases the group in order', () => {
    const head = new WarmStartHead(0);
    head.setHeadGroup(5n);
    expect(ids(head.push(data(5, 3), 10, true))).toEqual([]);
    expect(ids(head.push(data(5, 0), 20, true))).toEqual(['5:0']);
    expect(ids(head.push(data(5, 1), 30, true))).toEqual(['5:1']);
    expect(ids(head.push(data(5, 2), 40, true))).toEqual(['5:2', '5:3']);
  });

  it('releases the head group before a next group that arrives first', () => {
    // The current group ended at subscribe time: live starts at group 6.
    const head = new WarmStartHead(0);
    head.setHeadGroup(5n);
    expect(ids(head.push(data(6, 0), 10, true))).toEqual([]);
    expect(ids(head.push(data(5, 0), 20, true))).toEqual(['5:0']);
    expect(ids(head.push(endOfGroup(5, 1), 30, true))).toEqual(['5:1', '6:0']);
  });

  it('releases everything in order and passes through once the head fetch ends', () => {
    const head = new WarmStartHead(0);
    head.setHeadGroup(5n);
    head.push(data(5, 0), 10, true);
    expect(ids(head.push(data(6, 0), 20, true))).toEqual([]);
    expect(ids(head.push(data(5, 1), 30, false))).toEqual(['5:1', '6:0']);
    expect(head.done).toBe(true);
    expect(ids(head.push(data(6, 1), 40, false))).toEqual(['6:1']);
  });

  it('releases what it holds at the deadline even while the fetch is open', () => {
    const head = new WarmStartHead(0, 1_000);
    head.setHeadGroup(5n);
    expect(ids(head.push(data(5, 2), 10, true))).toEqual([]);
    expect(ids(head.push(data(5, 3), 1_000, true))).toEqual(['5:2', '5:3']);
    expect(head.done).toBe(true);
  });

  it('passes through when the track has no content yet', () => {
    const head = new WarmStartHead(0);
    head.setHeadGroup(null);
    expect(head.done).toBe(true);
    expect(ids(head.push(data(0, 0), 10, true))).toEqual(['0:0']);
  });

  it('drops duplicates of an object it still holds', () => {
    const head = new WarmStartHead(0);
    head.setHeadGroup(5n);
    head.push(data(5, 1), 10, true);
    head.push(data(5, 1), 20, true);
    expect(ids(head.push(data(5, 0), 30, true))).toEqual(['5:0', '5:1']);
  });
});
