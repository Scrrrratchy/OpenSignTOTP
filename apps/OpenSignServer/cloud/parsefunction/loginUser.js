import { createMfaLoginChallenge, isMfaEnabledForUser } from './mfa.js';
export default async function loginUser(request) {
  const username = request.params.email;
  const password = request.params.password;

  if (username && password) {
    try {
      // Pass the username and password to logIn function
      const user = await Parse.User.logIn(username, password, { useMasterKey: true });
      // console.log('user ', user);
      if (user) {
        if (await isMfaEnabledForUser(user.id)) {
          const challengeId = await createMfaLoginChallenge(user);
          return {
            requires2FA: true,
            challengeId,
          };
        }
        const _user = user?.toJSON();
        return {
          ..._user,
        };
      } else {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'user not found.');
      }
    } catch (err) {
      console.log('err in login user', err);
      throw err;
    }
  } else {
    throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'username/password is missing.');
  }
}
