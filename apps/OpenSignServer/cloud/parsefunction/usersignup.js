async function saveUser(userDetails, request) {
  const normalizedEmail = userDetails.email.toLowerCase().replace(/\s/g, '');
  const userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo('username', userDetails.email);
  const userRes = await userQuery.first({ useMasterKey: true });

  if (userRes) {
    if (request.user?.id !== userRes.id) throw new Parse.Error(119, 'Authentication required');
    return {
      id: userRes.id,
      sessionToken: request.headers?.['x-parse-session-token'] || request.user.getSessionToken(),
    };
  } else {
    const user = new Parse.User();
    user.set('username', userDetails.email);
    user.set('password', userDetails.password);
    user.set('email', userDetails?.email?.toLowerCase()?.replace(/\s/g, ''));
    user.set('normalizedEmail', normalizedEmail);

    if (userDetails?.phone) {
      user.set('phone', userDetails.phone);
    }
    user.set('name', userDetails.name);

    const res = await user.signUp();
    // console.log("res ", res);
    return { id: res.id, sessionToken: res.getSessionToken() };
  }
}
export default async function usersignup(request) {
  const userDetails = request.params.userDetails;

  try {
    if (userDetails?.role !== 'contracts_User') throw new Parse.Error(119, 'Invalid role');
    const user = await saveUser(userDetails, request);
    const extClass = userDetails.role.split('_')[0];

    const extQuery = new Parse.Query(extClass + '_Users');
    extQuery.equalTo('UserId', {
      __type: 'Pointer',
      className: '_User',
      objectId: user.id,
    });
    const extUser = await extQuery.first({ useMasterKey: true });
    if (extUser) {
      return { message: 'User already exist' };
    } else {
      // console.log("role ", role);
      const partnerCls = Parse.Object.extend('partners_Tenant');
      const partnerQuery = new partnerCls();
      partnerQuery.set('UserId', {
        __type: 'Pointer',
        className: '_User',
        objectId: user.id,
      });

      if (userDetails?.phone) {
        partnerQuery.set('ContactNumber', userDetails.phone);
      }
      partnerQuery.set('TenantName', userDetails.company);
      partnerQuery.set('EmailAddress', userDetails?.email?.toLowerCase()?.replace(/\s/g, ''));
      partnerQuery.set('IsActive', true);
      partnerQuery.set('CreatedBy', {
        __type: 'Pointer',
        className: '_User',
        objectId: user.id,
      });
      if (userDetails && userDetails.pincode) {
        partnerQuery.set('PinCode', userDetails.pincode);
      }
      if (userDetails && userDetails.country) {
        partnerQuery.set('Country', userDetails.country);
      }
      if (userDetails && userDetails.state) {
        partnerQuery.set('State', userDetails.state);
      }
      if (userDetails && userDetails.city) {
        partnerQuery.set('City', userDetails.city);
      }
      if (userDetails && userDetails.address) {
        partnerQuery.set('Address', userDetails.address);
      }
      const tenantRes = await partnerQuery.save(null, { useMasterKey: true });
      // console.log("tenantRes ", tenantRes);
      const extCls = Parse.Object.extend(extClass + '_Users');
      const newObj = new extCls();
      newObj.set('UserId', {
        __type: 'Pointer',
        className: '_User',
        objectId: user.id,
      });
      newObj.set('UserRole', userDetails.role);
      newObj.set('Email', userDetails?.email?.toLowerCase()?.replace(/\s/g, ''));
      newObj.set('Name', userDetails.name);
      if (userDetails?.phone) {
        newObj.set('Phone', userDetails?.phone);
      }
      newObj.set('TenantId', {
        __type: 'Pointer',
        className: 'partners_Tenant',
        objectId: tenantRes.id,
      });
      if (userDetails && userDetails.company) {
        newObj.set('Company', userDetails.company);
      }
      if (userDetails && userDetails.jobTitle) {
        newObj.set('JobTitle', userDetails.jobTitle);
      }
      if (userDetails && userDetails?.timezone) {
        newObj.set('Timezone', userDetails.timezone);
      }
      await newObj.save(null, { useMasterKey: true });
      return { message: 'User sign up', sessionToken: user.sessionToken };
    }
  } catch (err) {
    console.log('Err ', err);
  }
}
