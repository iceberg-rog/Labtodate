// Test-only preload: lib/auth-server uses React's `cache` (a React Server
// Components API). Outside Next there is no RSC runtime, so give scripts that
// import server code a pass-through `cache` (per-call, no memoisation).
const react = require('react');
if (typeof react.cache !== 'function') react.cache = (fn) => fn;
