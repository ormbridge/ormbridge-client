try {
// Check if React is installed
require('react');
} catch (e) {
throw new Error('React is required to use this adapter. Please install react as a dependency in your project.');
}

// Import and re-export the React adapter
export { useReactLiveView } from './adaptors/react.js';