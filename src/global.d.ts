/**
 * The info of a telegram user stored in firebase users/{uid}
 */
interface User {
  uid: string;
  nickname: string; // instead of their telegram username, users can explicitly ask you to register a nickname they want you to call them
  memories: string[]; // an array that contains all memories you add during the conversation with the user
}

/**
 * Other interfaces like chat history we will use the wrapper of telegram bot api (grammy)
 */
