export default {
  backendConfigs: {
    default: {
      API_URL: 'http://127.0.0.1:8000/statezero',
      GENERATED_TYPES_DIR: './models/backend1',
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      }),
      eventInterceptor: (event) => event,
      events: {
        type: 'pusher',
        pusher: {
          clientOptions: {
            appKey: '31f0a279ab07525d29ba',
            cluster: 'eu',
            forceTLS: true,
            authEndpoint: 'http://127.0.0.1:8000/statezero/events/auth/'
          }
        }
      }
    },
    microservice: {
      API_URL: 'http://127.0.0.1:8000/statezero',
      GENERATED_TYPES_DIR: './models/backend2',
      getAuthHeaders: () => ({
        'Authorization': 'Bearer your_microservice_token'
      }),
      eventInterceptor: (event) => event,
      events: {
        type: 'pusher',
        pusher: {
          clientOptions: {
            appKey: '31f0a279ab07525d29ba',
            cluster: 'eu',
            forceTLS: true,
            authEndpoint: 'http://127.0.0.1:8000/statezero/events/auth/'
          }
        }
      }
    }
  }
};
