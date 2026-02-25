#!/usr/bin/env node
// scripts/centova-upload-to-playlist.mjs
// Usage: node scripts/centova-upload-to-playlist.mjs <producerName> <audioFilePath>


import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.local from the project root or console-app directory
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const CENTOVA_API_URL = process.env.CENTOVA_API_URL; // e.g. 'https://your-centova-server:2199/api.php'
const CENTOVA_USERNAME = process.env.CENTOVA_USERNAME;
const CENTOVA_PASSWORD = process.env.CENTOVA_PASSWORD;

if (process.argv.length < 4) {
  console.error('Usage: node scripts/centova-upload-to-playlist.mjs <producerName> <audioFilePath>');
  process.exit(1);
}

const producerName = process.argv[2];
const audioFilePath = process.argv[3]; // e.g. media/producer-name/test.mp3

async function addTrackToPlaylist() {
  // Diagnostic: List available tracks in media library
  const songsParams = new URLSearchParams({
    xm: 'server.getsongs',
    f: 'json',
    'a[username]': CENTOVA_USERNAME,
    'a[password]': CENTOVA_PASSWORD,
  });
  const songsRes = await fetch(`${CENTOVA_API_URL}?${songsParams}`);
  const songsData = await songsRes.json();
  if (songsData.type === 'success' && songsData.response.data) {
    const songList = songsData.response.data[0]?.songs || [];
    console.log('Available tracks in media library:');
    songList.forEach((song) => {
      console.log('-', song.title);
    });
  } else {
    console.log('Could not retrieve media library tracks:', songsData.response?.message || songsData);
  }
  // 1. Ensure playlist exists (list playlists, create if missing)
  const playlistListParams = new URLSearchParams({
    xm: 'server.playlist',
    f: 'json',
    'a[username]': CENTOVA_USERNAME,
    'a[password]': CENTOVA_PASSWORD,
    'a[action]': 'list',
    'a[playlistname]': producerName,
  });
  const listRes = await fetch(`${CENTOVA_API_URL}?${playlistListParams}`);
  const listData = await listRes.json();
  let playlistExists = false;
  if (listData.type === 'success' && listData.response.data && listData.response.data.length > 0) {
    playlistExists = true;
  }
  // Optionally: create playlist if not exists (not shown here, as Centova may require UI for this)

  // 2. Add track to playlist
  const addParams = new URLSearchParams({
    xm: 'server.playlist',
    f: 'json',
    'a[username]': CENTOVA_USERNAME,
    'a[password]': CENTOVA_PASSWORD,
    'a[action]': 'add',
    'a[playlistname]': producerName,
    'a[trackpath]': audioFilePath,
  });
  const addRes = await fetch(`${CENTOVA_API_URL}?${addParams}`);
  const addData = await addRes.json();
  if (addData.type === 'success') {
    console.log(`Track ${audioFilePath} added to playlist ${producerName}`);
  } else {
    console.error('Failed to add track:', addData.response?.message || addData);
    process.exit(2);
  }

  // 3. Optionally: reindex media library (if needed)
  // const reindexParams = new URLSearchParams({
  //   xm: 'server.reindex',
  //   f: 'json',
  //   'a[username]': CENTOVA_USERNAME,
  //   'a[password]': CENTOVA_PASSWORD,
  // });
  // await fetch(`${CENTOVA_API_URL}?${reindexParams}`);
}

addTrackToPlaylist().catch((err) => {
  console.error('Error:', err);
  process.exit(3);
});
