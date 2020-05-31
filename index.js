// const util = require('util');
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const PlexAPI = require("plex-api");

(async function() {
  function loadConfig(path) {
    const fileContents = fs.readFileSync(path, 'utf8');
    const data = yaml.safeLoad(fileContents);

    console.log(data);
    return data;
  }

  async function seasons(client, show_key) {
    let ret = [];

    const url = `/library/metadata/${show_key}/children`;
    await client.query(url).then(function (result) {
      const mc = result.MediaContainer;
      const ssns = mc.Metadata;
      if (ssns.length > 0) {
        ssns.forEach(sn => { 
          const { index: number, ratingKey: season_key, title } = sn;
          ret.push({ number, season_key, title });
        });
        
        ret.sort((a, b) => a.number - b.number);
      } else {
        console.log('No episodes found.')
      }
    }, function (err) {
      console.error("Could not connect to server", err);
    });

    return ret;
  }

  async function episodes(client, season_key) {
    let ret = [];

    const url = `/library/metadata/${season_key}/children`;
    await client.query(url).then(function (result) {
      const mc = result.MediaContainer;
      // console.log(util.inspect(mc, false, null, true /* enable colors */))

      const eps = mc.Metadata;
      if (eps.length > 0) {
        eps.forEach(ep => { 
          const { index: number, parentIndex: seasonNumber, title, viewCount: watched, originallyAvailableAt: airdate } = ep;
          const paths = ep.Media.flatMap(m => m.Part.flatMap(p => p.file));

          ret.push({ number, seasonNumber, title, watched, airdate, paths });
        });
        
        ret.sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
      } else {
        console.log('No episodes found.')
      }
    }, function (err) {
      console.error("Could not connect to server", err);
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

    const season_list = await seasons(client, show_key);  
    console.log(`${season_list.length} seasons found.`);
    if (season_list.length == 0) { return []; }

    const episode_list = 
      await Promise.all(season_list.map(({ season_key }) => episodes(client, season_key)))
             .then(ep_list => ep_list.flat());

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
         // if you dellete the last episode in plex, plex deletes the whole show.
         // deleting season 0 (Specials) is probably just an accident. why risk it.
        state = 'K';
      } else if (watched > 0) { 
        // watched shows that I'm not going to rewatch. but give them a grace 
        // period in case someone else wants to watch them, or in case of 
        // accidents.
        if ((latest - idx) > stale_watched) {
          state = 'S';
        } else {
          state = 'W';
        }
      } else if (delete_unwatched) { 
        // unwatched and we are configured to delete episodes of 
        // this show after they get out of date (like news programs)
        if ((latest - idx) > stale_unwatched) {
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
  const hostname = process.env.PLEX_HOSTNAME;
  const token = process.env.PLEX_TOKEN;
  const client = new PlexAPI({"hostname": hostname, "token": token});
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
      const { number, seasonNumber, title, watched, airdate, paths, state, trash } = ep;  
      console.log(`${trash ? '!' : ' '}[${state}] ${seasonNumber.toString().padStart(2, ' ')} ${number.toString().padStart(3, ' ')}. ${airdate}: "${title}". ${paths.length} file(s).`);
      if (trash) {
        to_delete.push(...paths);
      }
    });
  });

  console.log(`\n\nFound ${to_delete.length} files to delete.\n`);
  if (to_delete.length == 0) { return; }

  to_delete.sort();
  
  const by_show = _.chain(to_delete)
    .groupBy(path.dirname)
    .toPairs()
    .groupBy(p => path.dirname(p[0]))
    .value();

  Object.keys(by_show).forEach(show => {
    console.log(`\n== ${show} ==`);
    const dir = `${prefix}${show}`;
    if (!fs.existsSync(dir)){
      console.log(`Directory ${dir} not found...`);
      return;
    }  
    
    for (var [season, files] of by_show[show]) {
      console.log(`\n-- ${season} --`);
      const dir = `${prefix}${season}`;
  
      if (!fs.existsSync(dir)){
        console.log(`Directory ${dir} not found...`);
        continue;
      }  

      const before = fs.readdirSync(dir).length;
      console.log(`Deleting ${files.length} files out of ${before}.`);
      files.forEach(file => {
        const path = `${prefix}${file}`;
        if (!fs.existsSync(path)){
          console.log(`File ${path} not found...`);
          return;
        }  

        console.log(`Deleting ${path}...`);
        try {
          fs.unlinkSync(path);
        } catch (e) {
          console.error(e);
        }
      });

      const after = fs.readdirSync(dir).length;
      if (after == 0) {
        console.log("Deleting empty directory...");
        try {
          fs.rmdirSync(dir);
        } catch (e) {
          console.error(e);
        }
      }
    }

    // Check if there are any other directories in show dir that are empty
    // and delete them.
    fs.readdirSync(dir, {withFileTypes: true}).forEach(item => {
      if (item.isDirectory()) {
        const path = `${dir}/${item.name}`;
        if (fs.readdirSync(path).length == 0) {
          console.log(`Found another empty directory ${path}. Deleting...`);
          try {
            fs.rmdirSync(path);
          } catch (e) {
            console.error(e);
          }
        }
      }
    });
  });
})();
