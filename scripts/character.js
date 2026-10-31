// Pick the character that sits beside the island. It's optional: the island works the same without.
//   npm run character                         ask for an image (any time, to change it)
//   npm run character -- "C:\pics\me.png"     use that image, no questions (scripts, AI assistants);
//                                             a picture without transparency needs --anyway
//   node scripts/character.js --if-needed     offer one only the first time (run by `npm start`);
//                                             the answer defaults to no
//   node scripts/character.js --remove        go back to no character
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const character = require('../src/character.js');

const args = process.argv.slice(2);
const dir = character.dataDir();
const configFile = path.join(dir, 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')) || {}; } catch { return {}; }
}
function markAsked() {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), characterAsked: true }, null, 2));
}

async function main() {
  if (args.includes('--remove')) {
    character.remove(dir);
    console.log('Character removed. Restart the island (tray icon > Quit, then start it again) to see the change.');
    return;
  }
  const given = args.find((a) => !a.startsWith('--'));
  if (given) {
    const file = given.trim().replace(/^["'&\s]+|["'\s]+$/g, '');
    if (!fs.existsSync(file)) throw new Error(`Couldn't find ${file}`);
    if (!character.IMAGE.test(file)) throw new Error("That isn't an image the island can use. Pick a PNG, JPG, GIF or BMP.");
    if (character.transparency(file) === 'no' && !args.includes('--anyway')) {
      throw new Error("That picture has no transparent background, so it'll show as a rectangle. "
        + 'Pick a PNG with a transparent background, or add --anyway to use it as it is.');
    }
    const saved = character.install(file, dir);
    markAsked();
    console.log(`Done. Saved to ${saved}. If the island is already running, restart it to see it.`);
    return;
  }
  const firstStart = args.includes('--if-needed');
  if (firstStart) {
    // Only on a first start in a terminal: never when there's already a picture, when it was
    // answered before, or when nobody is there to answer.
    if (fs.existsSync(character.characterFile(dir)) || readConfig().characterAsked || !process.stdin.isTTY) return;
  }

  // Lines are queued as they arrive (a fast paste or piped input can come before the question),
  // and the end of input counts as skipping.
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    if (!process.stdin.isTTY) process.stdout.write(`${done ? '' : value}\n`);
    return done ? '' : value;
  };
  try {
    console.log('');
    if (firstStart) {
      console.log('  Optional: Floating Island can show a character beside the island (an anime character, a');
      console.log('  pet, anything) that pulls it down. Without one, the island simply drops down by itself.');
      console.log('');
      const want = await ask('  Add a character now? (y/N) ');
      if (!/^y/i.test(want.trim())) {
        markAsked();
        console.log('  No character. You can add one any time with: npm run character');
        console.log('');
        return;
      }
      console.log('');
    } else {
      console.log('  Pick a character to sit beside the island (an anime character, a pet, anything).');
    }
    console.log('  Use a PNG with a TRANSPARENT background for the best look (anything else shows as a rectangle).');
    console.log('  Tip: drag the image file into this window to paste its path. Press Enter to skip.');
    console.log('');
    for (;;) {
      const answer = (await ask('  Image file: ')).trim().replace(/^["'&\s]+|["'\s]+$/g, '');
      if (!answer) {
        console.log('  Skipped. You can add one any time with: npm run character');
        markAsked();
        return;
      }
      if (!fs.existsSync(answer)) {
        console.log("  Couldn't find that file. Try again, or press Enter to skip.");
        continue;
      }
      if (!character.IMAGE.test(answer)) {
        console.log("  That isn't an image the island can use. Pick a PNG, JPG, GIF or BMP.");
        continue;
      }
      if (character.transparency(answer) === 'no') {
        const ok = await ask("  That picture has no transparent background, so it'll show as a rectangle. Use it anyway? (y/N) ");
        if (!/^y/i.test(ok.trim())) {
          console.log('  OK. Pick another (a transparent PNG), or press Enter to skip.');
          continue;
        }
      }
      try {
        const saved = character.install(answer, dir);
        markAsked();
        console.log(`  Done. Saved to ${saved}.`);
        console.log('  It appears beside the island. If the island is already running, restart it to see it.');
        return;
      } catch (err) {
        console.log(`  ${err.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
