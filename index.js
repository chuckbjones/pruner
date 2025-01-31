import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import YAML from 'yaml';
import { PlexServer, Show } from '@ctrl/plex';

(async function() {
  function loadConfig(path) {
    const fileContents = readFileSync(path, 'utf8');
    const data = YAML.parse(fileContents);

    console.log(data);
    return data;
  }

  async function show(client, show_key) {
    const key = `/library/metadata/${show_key}`;
    const resp = await client.query(key);
    const data = resp.MediaContainer.Metadata[0];
    return new Show(client, data, show_key);
  }

  async function episodes(client, show_key) {
    let ret = [];

    await show(client, show_key).then(s => {
      return s.episodes().then(eps => {
        if (eps.length > 0) {
          eps.forEach(ep => { 
            const { index: number, parentIndex: seasonNumber, title, viewCount: watched, originallyAvailableAt: airdate } = ep;
            const paths = ep.media.flatMap(m => m.parts.flatMap(p => p.file));

            ret.push({ number, seasonNumber, title, watched, airdate, paths });
          });
        
          ret.sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
        } else {
          console.log('[WARNING] No episodes returned.')
        }
      }, function (err) {
        console.error(`[ERROR] Failed to fetch episodes for show_key ${show_key}`, err);
      });
    }, function (err) {
      console.error(`[ERROR] Failed to fetch show data for show_key ${show_key}`, err);
    });

    return ret;
  }

  async function fetchShowInfo(client, show) {
    const show_key = show.ratingKey;
    const delete_unwatched = show.delete_unwatched || false;
    const stale_unwatched = show.stale_unwatched || Infinity;
    const stale_watched = show.stale_watched || Infinity;

    console.log(`\n\n== ${show.title} ==`);
    console.log(` key:              ${show_key}`);
    console.log(` delete_unwatched: ${delete_unwatched}`);
    console.log(` stale_unwatched:  ${stale_unwatched}`);
    console.log(` stale_watched:    ${stale_watched}`);

    const episode_list = await episodes(client, show_key);
    console.log(`${episode_list.length} episodes found.`);
    if (episode_list.length == 0) { return []; }

    const latest = episode_list.length - 1; // we know this is the latest because we sorted the list.
    episode_list.forEach((ep, idx, _arr) => { 
      const { number, seasonNumber, title, watched, airdate, paths } = ep;  
      let state = 'U'; // U = Unwatched (keep). 
                       // S = Stale (old; delete - watched or unwatched)
                       // W = Watched (still new; keep for now.) 
                       // K = Keep (special cases. see below.)
      if (idx == latest || seasonNumber == 0) {
         // latest episode. if you delete it, it will mess up the on deck.
         // if you delete the last episode in plex, plex deletes the whole show.
         // deleting season 0 (Specials) is probably just an accident. why risk it.
        state = 'K';
      } else if (watched > 0) { 
        // watched shows that I'm not going to rewatch. but give them a grace 
        // period in case someone else wants to watch them, or in case of 
        // accidents.
        if ((latest - idx) >= stale_watched) {
          state = 'S';
        } else {
          state = 'W';
        }
      } else if (delete_unwatched) { 
        // unwatched and we are configured to delete episodes of 
        // this show after they get out of date (like news programs)
        if ((latest - idx) >= stale_unwatched) {
          state = 'S'
        }
      }

      ep.state = state;
      ep.trash = (state == 'S');
    });

    return episode_list;
  }

  const config_path = process.argv[2];
  const config = loadConfig(config_path);
  const prefix = process.env.PRUNER_PATH_PREFIX || '';
  const api_url = process.env.PLEX_URL;
  const token = process.env.PLEX_TOKEN;
  const client = new PlexServer(api_url, token);
  console.log(`${Object.keys(config).length} shows found in config file.`);
  console.log('Fetching show info...');

  const show_info = {};
  for (const name of Object.keys(config)) {
    show_info[name] = await fetchShowInfo(client, config[name]);
  }

  console.log("\n\nDone.");

  const to_delete = [];

  Object.keys(show_info).forEach(name => {
    console.log(`\n\n== ${config[name].title} ==`);
    show_info[name].forEach(ep => {
      const { number, seasonNumber, title, airdate, paths, state, trash } = ep;
      const dstr = (airdate instanceof Date && !isNaN(airdate)) ? airdate.toISOString().slice(0,10) : airdate.toString()
      console.log(`${trash ? '!' : ' '}[${state}] ${seasonNumber.toString().padStart(2, ' ')} ${number.toString().padStart(3, ' ')}. ${dstr}: "${title}". ${paths.length} file(s).`);
      if (trash) {
        to_delete.push(...paths);
      }
    });
  });

  console.log(`\n\nFound ${to_delete.length} files to delete.\n`);
  if (to_delete.length == 0) { return; }

  to_delete.sort();
  
  const by_season = Map.groupBy(to_delete, p => dirname(p))
  const by_show = Map.groupBy(by_season, p => dirname(p[0]))

  by_show.forEach((seasons, show) => {
    console.log(`\n== ${show} ==`);
    const dir = `${prefix}${show}`;
    if (!existsSync(dir)){
      console.log(`[WARNING] Directory ${dir} not found...`);
      return;
    }  
    
    for (var [season, files] of seasons) {
      console.log(`\n-- ${season} --`);
      const dir = `${prefix}${season}`;
  
      if (!existsSync(dir)){
        console.log(`[WARNING] Directory ${dir} not found...`);
        continue;
      }  

      const before = readdirSync(dir).length;
      console.log(`Deleting ${files.length} files out of ${before}.`);
      files.forEach(file => {
        const path = `${prefix}${file}`;
        if (!existsSync(path)){
          console.log(`[WARNING] File ${path} not found...`);
          return;
        }  

        console.log(`Deleting ${path}...`);
        try {
          unlinkSync(path);
        } catch (e) {
          console.error(`[ERROR] ${e}`);
        }
      });

      const after = readdirSync(dir).length;
      if (after == 0) {
        console.log("Deleting empty directory...");
        try {
          rmdirSync(dir);
        } catch (e) {
          console.error(`[ERROR] ${e}`);
        }
      }
    }

    // Check if there are any other directories in show dir that are empty
    // and delete them.
    readdirSync(dir, {withFileTypes: true}).forEach(item => {
      if (item.isDirectory()) {
        const path = `${dir}/${item.name}`;
        if (readdirSync(path).length == 0) {
          console.log(`Found another empty directory ${path}. Deleting...`);
          try {
            rmdirSync(path);
          } catch (e) {
            console.error(`[ERROR] ${e}`);
          }
        }
      }
    });
  });
})();
