import { initializeApp } from 'firebase/app'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

// NO Realtime Database — the single-player family has no live state (architecture
// §4.1). There is deliberately no getDatabase(), no databaseURL, no DATABASE_URL env.

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)

export const db        = getFirestore(app)
export const auth      = getAuth(app)
export const functions = getFunctions(app)

// Emulator ports mirror ../firebase.json (this project's own ports — distinct from
// other games so several emulators can run side by side).
if (import.meta.env.DEV) {
  connectFunctionsEmulator(functions, 'localhost', 5010)
  connectFirestoreEmulator(db,        'localhost', 8090)
  connectAuthEmulator(auth, 'http://localhost:9110')
}
