import { config } from '../config.js';
import { GoogleAccount, GoogleCalendar, GoogleDrive } from './google.js';
import { Telegram } from './telegram.js';
import { DemoCalendar, DemoDrive, DemoTelegram } from './demo.js';

export const account = config.demo ? null : new GoogleAccount();

export const integrations = config.demo
  ? { calendar: new DemoCalendar(), drive: new DemoDrive(), telegram: new DemoTelegram() }
  : { calendar: new GoogleCalendar(account), drive: new GoogleDrive(account), telegram: new Telegram() };
