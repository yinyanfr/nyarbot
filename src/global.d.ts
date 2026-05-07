/**
 * The info of a telegram user stored in firebase users/{uid}
 */
export interface User {
  uid: string;
  nickname: string; // instead of their telegram username, users can explicitly ask you to register a nickname they want you to call them
  memories: string[]; // an array that contains all memories you add during the conversation with the user
  nightyTimestamp?: number; // timestamp of last goodnight (server time, ms)
  lastMorningGreet?: number; // timestamp of last morning greeting (prevents duplicates within same cycle)
}
