import { useState, useEffect } from "react";
import Parse from "parse";
import { Outlet } from "react-router";
import SessionExpiredModal from "./SessionExpiredModal";

const Validate = () => {
  const [isUserValid, setIsUserValid] = useState(true);
  useEffect(() => {
    (async () => {
      if (localStorage.getItem("accesstoken")) {
        try {
          const storedParseUser = JSON.parse(
            localStorage.getItem(
              `Parse/${localStorage.getItem("parseAppId")}/currentUser`
            ) || "null"
          );
          const storedUser = JSON.parse(
            localStorage.getItem("UserInformation") || "null"
          );
          const userId =
            Parse.User.current()?.id ||
            storedParseUser?.objectId ||
            storedUser?.objectId;
          if (!userId) {
            setIsUserValid(false);
            return;
          }
          // Use the session token to validate the user
          const userQuery = new Parse.Query(Parse.User);
          const user = await userQuery.get(userId, {
            sessionToken: localStorage.getItem("accesstoken")
          });
          if (user) {
            setIsUserValid(true);
          } else {
            setIsUserValid(false);
          }
        } catch (error) {
          // Session token is invalid or there was an error
          setIsUserValid(false);
        }
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return isUserValid ? <Outlet /> : <SessionExpiredModal />;
};

export default Validate;
