/**
 * List the models this OPENAI_API_KEY can actually use, and say whether the one
 * the briefing is configured to use is among them.
 *
 * Model ids are not stable across accounts or across time — the id that shipped
 * as the default here may simply not be enabled on your key, and the run then
 * dies with "the requested model does not exist" after doing all the feed work.
 * This tells you what to put in OPENAI_MODEL before that happens:
 *
 *   npm run check-models
 */
import { createClient, DEFAULT_MODEL, MODEL } from '../lib/openai';
import { envString } from '../lib/env';

async function main(): Promise<void> {
  const client = createClient();

  const ids: string[] = [];
  for await (const model of client.models.list()) {
    ids.push(model.id);
  }
  ids.sort();

  const configured = envString('OPENAI_MODEL');
  console.log(
    configured
      ? `OPENAI_MODEL is set to "${configured}".`
      : `OPENAI_MODEL is not set — falling back to the built-in default "${DEFAULT_MODEL}".`,
  );

  const available = ids.includes(MODEL);
  console.log(`${available ? '✅' : '❌'} "${MODEL}" is ${available ? '' : 'NOT '}available on this key.\n`);

  // The briefing only ever wants a chat/reasoning model, so lead with those and
  // keep the embeddings/audio/image ids out of the way.
  const chatty = ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id));
  const rest = ids.filter((id) => !chatty.includes(id));

  console.log(`Text models on this key (${chatty.length}):`);
  for (const id of chatty) console.log(`  ${id}`);
  if (rest.length) console.log(`\n(plus ${rest.length} non-text models: embeddings, audio, images.)`);

  if (!available) {
    console.log(
      '\nPick a small one from the list above and set OPENAI_MODEL to it — in .env.local for local runs,\n' +
        'in Vercel for the site, and as a repository variable for the scheduled run\n' +
        '(Settings > Secrets and variables > Actions > Variables). The workflow already maps it into the job.',
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
