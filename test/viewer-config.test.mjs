// The model viewer's config options: its folders must be inside the project.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadProject } from '../src/project.mjs';
import { SAMPLE } from './helpers.mjs';

describe('the model viewer\'s config', () => {
  it('models and reviews are folders inside the project', async () => {
    const p = await loadProject({ root: SAMPLE, config: { models: 'models' } });
    assert.equal(p.modelsDir, join(SAMPLE, 'models')); assert.equal(p.reviewsDir, join(SAMPLE, '.review'));
    assert.deepEqual(p.reviewWorkflows.map((w) => w.id), ['auto', 'blender', 'comfyui']);
    assert.equal((await loadProject({ root: SAMPLE, config: {} })).modelsDir, null);
    await assert.rejects(loadProject({ root: SAMPLE, config: { models: '../elsewhere' } }), /"models" must be a folder inside the project/);
    await assert.rejects(loadProject({ root: SAMPLE, config: { reviews: '/tmp/x' } }), /"reviews" must be a folder inside the project/);
  });
});
