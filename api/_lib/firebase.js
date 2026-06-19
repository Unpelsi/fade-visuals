import { getApps, initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyCD61hKVJi16c0NVQTV1ZKOsFjjeXdgzXQ',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'fade-client.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'fade-client',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'fade-client.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '838857350681',
  appId: process.env.FIREBASE_APP_ID || '1:838857350681:web:125f4f7bab426ab8f49488',
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://fade-client-default-rtdb.firebaseio.com'
};

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);

export const db = getDatabase(app);
export const webApiKey = process.env.FIREBASE_WEB_API_KEY || firebaseConfig.apiKey;
