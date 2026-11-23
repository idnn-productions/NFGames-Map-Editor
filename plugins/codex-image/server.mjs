// Image generation through the user's Codex login: `codex exec` asked to draw, saving into .nfgames/images/<time>/ in
// the project, as a job (so it shows in Jobs). Input { prompt, count = 1, references: [project-relative image paths] };
// result { images: [paths], folder }.
export function activate(api) {
  api.services.provide('image', 'generate', async ({ prompt, count = 1, references = [] }) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt: describe the image');
    const n = Math.max(1, Math.min(8, Number(count) || 1));
    const folder = `.nfgames/images/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    api.files.write(`${folder}/prompt.txt`, `${prompt}\n`);
    const refs = (Array.isArray(references) ? references : []).filter((r) => typeof r === 'string' && r && !r.startsWith('-') && !r.includes('..')).flatMap((r) => ['-i', r]);
    const ask = `Use your image generation tool to make ${n} image${n > 1 ? 's' : ''}: ${prompt.trim()}\n${refs.length ? 'Pass the attached reference images to every generation. ' : ''}Save each as PNG into ./${folder}/ named image-1.png, image-2.png and so on. Do not create or change any other file.`;
    const job = await api.jobs.run(`Generate ${n} image${n > 1 ? 's' : ''}`, [{ label: 'codex', command: ['codex', 'exec', '--skip-git-repo-check', '-C', api.project.root, '-s', 'workspace-write', ...refs, ask] }]).done;
    if (job.state !== 'done') throw new Error('Codex did not finish: see Jobs for its output');
    const images = api.files.list(folder).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => `${folder}/${f}`);
    if (!images.length) throw new Error('Codex finished but saved no image: see Jobs for its output');
    return { images, folder };
  });
}
