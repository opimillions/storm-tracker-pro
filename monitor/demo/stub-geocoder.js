// DEMO ONLY: this sandbox has no internet, so the Census geocoder answers locally
// for the known-storm address. Loaded with `node -r` into a local StormCheck run.
const axios = require('axios');
const realGet = axios.get.bind(axios);
axios.get = async (url, opts) => {
  if (String(url).includes('geocoding.geo.census.gov')) {
    return { data: { result: { addressMatches: [{ coordinates: { x: -97.1331, y: 32.9420 }, matchedAddress: '100 E SOUTHLAKE BLVD, SOUTHLAKE, TX, 76092', addressComponents: { state: 'TX', zip: '76092' } }] } } };
  }
  return realGet(url, opts);
};
