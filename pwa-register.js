// Register service worker and add manifest link dynamically
(function(){
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  }
  // add manifest link into head if not present
  if (!document.querySelector('link[rel="manifest"]')){
    const l = document.createElement('link');
    l.rel = 'manifest';
    l.href = '/manifest.json';
    document.head.appendChild(l);
  }
})();