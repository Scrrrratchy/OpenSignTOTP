import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";

const model = vi.hoisted(() => ({
  cloud: vi.fn(),
  put: vi.fn(),
  get: vi.fn(),
  dispatch: vi.fn(),
  language: { changeLanguage: vi.fn() },
  state: null
}));

vi.mock("parse", () => ({
  default: {
    User: { current: () => ({ id: "user-one" }) },
    Query: class {
      get = model.get;
    },
    Cloud: { run: model.cloud }
  }
}));
vi.mock("axios", () => ({ default: { put: model.put } }));
vi.mock("react-redux", () => ({
  useDispatch: () => model.dispatch,
  useSelector: (selector) => selector(model.state)
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key) => key, i18n: model.language })
}));
vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/dashboard" }),
  Outlet: () => <div>Dashboard</div>
}));
vi.mock("../constant/const", () => ({ runtimeUrls: {} }));
vi.mock("../constant/Utils", () => ({ nonPresentMaskCss: {} }));
vi.mock("../components/Header", () => ({ default: () => null }));
vi.mock("../components/Footer", () => ({ default: () => null }));
vi.mock("../components/sidebar/Sidebar", () => ({ default: () => null }));
vi.mock("../components/PageScrollContainer", () => ({
  default: ({ children }) => <main>{children}</main>
}));
vi.mock("../primitives/SessionExpiredModal", () => ({
  default: () => <div>Session expired</div>
}));
vi.mock("../primitives/Tour", () => ({
  default: ({ onRequestClose }) => (
    <div role="dialog">
      <button onClick={onRequestClose}>Close introduction</button>
    </div>
  )
}));

import HomeLayout from "./HomeLayout";

const profile = (TourStatus = []) => ({ objectId: "profile-one", TourStatus });
const storedProfile = () => JSON.parse(localStorage.getItem("Extand_Class"))[0];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("accesstoken", "session-one");
  localStorage.setItem("TenantId", "tenant-one");
  localStorage.setItem("parseAppId", "app-one");
  localStorage.setItem("baseUrl", "http://localhost/app/");
  localStorage.setItem("Extand_Class", JSON.stringify([profile()]));
  model.state = {
    TourSteps: [{ selector: "main", content: "Dashboard" }],
    user: { isValidSession: true }
  };
  model.get.mockResolvedValue({ get: () => "" });
  model.cloud.mockResolvedValue(profile());
  model.put.mockResolvedValue({ data: { updatedAt: "now" } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboard introduction", () => {
  it("saves dismissal with the user's session and stays closed after navigation and a fresh login", async () => {
    model.cloud.mockResolvedValue(profile([{ requestSign: true }]));
    const view = render(<HomeLayout />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close introduction" })
    );
    await waitFor(() =>
      expect(storedProfile().TourStatus).toContainEqual({ loginTour: true })
    );
    expect(model.put).toHaveBeenCalledWith(
      "http://localhost/app/classes/contracts_Users/profile-one",
      { TourStatus: { __op: "AddUnique", objects: [{ loginTour: true }] } },
      {
        headers: {
          "X-Parse-Application-Id": "app-one",
          "X-Parse-Session-Token": "session-one"
        }
      }
    );
    expect(storedProfile().TourStatus).toContainEqual({ requestSign: true });
    model.state.TourSteps = [...model.state.TourSteps];
    view.rerender(<HomeLayout />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(model.cloud).toHaveBeenCalledTimes(1);
    const saved = storedProfile();
    view.unmount();
    localStorage.setItem("accesstoken", "new-login-session");
    model.cloud.mockResolvedValue(saved);
    render(<HomeLayout />);
    await waitFor(() => expect(model.cloud).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open an already completed tour", async () => {
    model.cloud.mockResolvedValue(
      profile([{ loginTour: false }, { loginTour: true }])
    );
    render(<HomeLayout />);
    await waitFor(() =>
      expect(storedProfile().TourStatus).toContainEqual({ loginTour: true })
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(model.put).not.toHaveBeenCalled();
  });

  it("ignores an old dashboard response arriving after dismissal", async () => {
    let resolveOld;
    model.cloud.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const view = render(<HomeLayout />);
    await waitFor(() => expect(model.cloud).toHaveBeenCalledTimes(1));
    model.state.TourSteps = [...model.state.TourSteps];
    view.rerender(<HomeLayout />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close introduction" })
    );
    await waitFor(() =>
      expect(storedProfile().TourStatus).toContainEqual({ loginTour: true })
    );
    await act(async () => resolveOld(profile()));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(storedProfile().TourStatus).toContainEqual({ loginTour: true });
  });

  it("reports save failure without claiming completion and allows a retry on the next dashboard visit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    model.put.mockRejectedValueOnce(new Error("network unavailable"));
    const view = render(<HomeLayout />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close introduction" })
    );
    await screen.findByRole("alert");
    expect(storedProfile().TourStatus).not.toContainEqual({ loginTour: true });
    model.state.TourSteps = [...model.state.TourSteps];
    view.rerender(<HomeLayout />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close introduction" })
    );
    await waitFor(() =>
      expect(storedProfile().TourStatus).toContainEqual({ loginTour: true })
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not launch a tour when the profile is missing or cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    model.cloud.mockRejectedValueOnce(new Error("unavailable"));
    const view = render(<HomeLayout />);
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    model.cloud.mockResolvedValueOnce("");
    model.state.TourSteps = [...model.state.TourSteps];
    view.rerender(<HomeLayout />);
    await waitFor(() => expect(model.cloud).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
