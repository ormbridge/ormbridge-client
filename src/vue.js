try {
    // Check if Vue is installed
    require('vue');
  } catch (e) {
    throw new Error('Vue is required to use this adapter. Please install vue as a dependency in your project.');
  }
  
  // Import and re-export the Vue adapter functions
  export { 
    useVueLiveView, 
    createVueLiveView, 
    createVueOptionsMixin 
  } from './adaptors/vue.js';