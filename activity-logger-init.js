// activity-logger-init.js
import { initActivityLogger } from './activity-logger.js';

initActivityLogger({
  pageViews: true,
  explicitClicks: true,
  allClicks: false,
  formSubmits: true
});