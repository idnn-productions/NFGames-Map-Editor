// The built-in fit check and the plants check, on the sample map.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadProject } from '../src/project.mjs';
import { checkFit, checkPlants } from '../src/check.mjs';
import { SAMPLE, samplePlan, samplePlants } from './helpers.mjs';

const project = await loadProject({ root: SAMPLE });
const kinds = await project.kinds('plaza', samplePlan());
const found = (plan) => checkFit(plan, kinds);
const kindsFound = (plan) => found(plan).map((p) => p.kind);

describe('the fit check', () => {
  it('finds nothing wrong with the sample map', () => { assert.deepEqual(found(samplePlan()), []); });
  it('finds two pieces in each other, and names both', () => {
    const plan = samplePlan(); plan.pieces.find((p) => p.id === 'h2').at = [-6, 11];
    const o = found(plan).find((p) => p.kind === 'overlap');
    assert.deepEqual(o.sel.sort(), ['piece:h1', 'piece:h2']);
  });
  it('walks into an open hall: only its walls count', () => {
    const plan = samplePlan(); plan.pieces.push({ id: 'box', kind: 'kit:crate', at: [-1, -17], rot: 0 });
    assert.deepEqual(found(plan), []);
    plan.pieces.find((p) => p.id === 'box').at = [-1, -21.5]; // in its back wall
    assert.deepEqual(kindsFound(plan), ['overlap']);
  });
  it('finds a piece beyond the ring, and beyond bounds', () => {
    const plan = samplePlan(); plan.pieces.find((p) => p.id === 'h2').at = [4, 22.5];
    assert.ok(kindsFound(plan).includes('outside'));
    const boxed = samplePlan(); delete boxed.ring; delete boxed.gate; boxed.bounds = { min: [-20, -20], max: [20, 13] };
    assert.deepEqual(found(boxed).filter((p) => p.kind === 'outside').map((p) => p.sel[0]).sort(), ['piece:h2', 'piece:hall']);
  });
  it('finds the player arriving in a wall, a person in a house, a round through one', () => {
    const plan = samplePlan(); plan.spawn.at = [-8, 10]; plan.people.keeper = [6, -10]; plan.routes.push([[-20, -10], [-4, -10]]);
    const k = kindsFound(plan);
    for (const want of ['spawn', 'person', 'round']) assert.ok(k.includes(want), want);
    assert.equal(found(plan).find((p) => p.kind === 'round').sel[0], 'route:1:0');
  });
  it('a thing is fine while there is somewhere to stand within its radius', () => {
    const plan = samplePlan(); plan.things[0].at = [6, -9]; plan.things[0].radius = 4; // inside the tower, but its door is within reach
    assert.deepEqual(found(plan), []);
    plan.things[0].radius = 0.5;
    assert.deepEqual(kindsFound(plan), ['thing']);
  });
  it('finds a blocked door, and a door on a kind with no door', () => {
    const plan = samplePlan(); plan.pieces.push({ id: 'crate3', kind: 'kit:crate', at: [-8, 7.2], rot: 0 }); // on h1's doorstep
    const d = found(plan).filter((p) => p.kind === 'door');
    assert.equal(d.length, 1); assert.match(d[0].text, /door home/);
    const odd = samplePlan(); odd.doors.push({ id: 'odd', piece: 'stall' });
    assert.match(found(odd).find((p) => p.kind === 'door').text, /no known door/);
  });
  it('finds a lifted piece over nothing, at the wrong height, or hanging off', () => {
    const plan = samplePlan(), tank = plan.pieces.find((p) => p.id === 'tank');
    tank.at = [-14, 0]; assert.match(found(plan)[0].text, /over nothing/);
    tank.at = [-8, 10]; tank.y = 4.2; assert.match(found(plan)[0].text, /floats 0\.70/);
    tank.y = 3.5; tank.at = [-6.5, 10]; assert.deepEqual(kindsFound(plan), ['overhang']);
  });
});

describe('the plants check', () => {
  const options = { plantKinds: project.plants.kinds, tall: project.plants.tall };
  it('finds nothing wrong with the sample plants', () => { assert.deepEqual(checkPlants(samplePlants(), samplePlan(), kinds, options), []); });
  it('warns of a plant of an unknown kind, outside, in a piece, in a doorway, on a round', () => {
    const plants = { points: [{ kind: 'palm', at: [0, 0] }, { kind: 'shrub', at: [0, 30] }, { kind: 'shrub', at: [-8, 10] }, { kind: 'shrub', at: [-8, 7.5] }, { kind: 'cactus', at: [-8, 5.6] }, { kind: 'shrub', at: [-8, 5.7] }] };
    const f = checkPlants(plants, samplePlan(), kinds, options), text = (i) => (f.find((p) => p.sel[0] === `plant:${i}`) || { text: '' }).text;
    assert.match(text(0), /not a kind/);
    assert.match(text(1), /outside/);
    assert.match(text(2), /inside h1/);
    assert.match(text(3), /doorway/);
    assert.match(text(4), /round/); // a tall one keeps a metre off
    assert.equal(text(5), ''); // a low one 0.6 m
  });
});
