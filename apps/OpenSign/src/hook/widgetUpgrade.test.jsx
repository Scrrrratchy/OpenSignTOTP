import React, { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook
} from "@testing-library/react";
import useWidgetHistory from "./useWidgetHistory";
import useWidgetAreaSelection from "./useWidgetAreaSelection";
import {
  isLocalQaBuild,
  isLocalQaIdentityEnabled
} from "../qa/localQaIdentity";

vi.mock("../constant/Utils", () => ({ handleDeleteWidget: vi.fn() }));
afterEach(cleanup);

const widgets = [
  {
    key: "signature",
    type: "signature",
    xPosition: 20,
    yPosition: 20,
    options: { required: true }
  },
  {
    key: "text",
    type: "textbox",
    xPosition: 180,
    yPosition: 20,
    options: { defaultValue: "Bestandswert" }
  },
  { key: "outside", type: "date", xPosition: 450, yPosition: 20 }
];
const page = () => [{ pageNumber: 1, pos: structuredClone(widgets) }];

describe("3.1.0 widget features on existing documents", () => {
  it("undoes and redoes copied widgets without losing existing widget properties", () => {
    const { result } = renderHook(() => useWidgetHistory(false));
    act(() => result.current[1](page()));
    act(() =>
      result.current[2]((pages) => [
        {
          ...pages[0],
          pos: [
            ...pages[0].pos,
            { ...pages[0].pos[0], key: "copied-signature", xPosition: 110 }
          ]
        }
      ])
    );
    expect(result.current[0][0].pos).toHaveLength(4);
    act(() => result.current[3].undo());
    expect(result.current[0]).toEqual(page());
    act(() => result.current[3].redo());
    expect(result.current[0][0].pos[3]).toMatchObject({
      key: "copied-signature",
      type: "signature",
      options: { required: true }
    });
  });

  it("restores deleted recipient fields with their original assignments and metadata", () => {
    const existing = [
      {
        Id: "recipient",
        Role: "Kunde",
        Email: "test@example.test",
        placeHolder: page()
      }
    ];
    const { result } = renderHook(() => useWidgetHistory(true));
    act(() => result.current[1](structuredClone(existing)));
    act(() =>
      result.current[2]((signers) => [{ ...signers[0], placeHolder: [] }])
    );
    act(() => result.current[3].undo());
    expect(result.current[0]).toEqual(existing);
    act(() => result.current[3].redo());
    expect(result.current[0][0].Email).toBe("test@example.test");
    expect(result.current[0][0].placeHolder).toBeUndefined();
  });

  it("selects and deletes multiple fields as one undoable operation", () => {
    let editor;
    function Editor() {
      const [positions, setPositions, record, history] =
        useWidgetHistory(false);
      const containerRef = useRef(null);
      useEffect(() => {
        setPositions(page());
      }, [setPositions]);
      const selection = useWidgetAreaSelection({
        enabled: true,
        containerRef,
        positions,
        setPositions: record,
        nested: false,
        scale: 1
      });
      editor = { positions, history, selection, containerRef };
      return (
        <div ref={containerRef}>
          <div data-page-number="1">
            {positions
              .flatMap((p) => p.pos)
              .map((widget) => (
                <span key={widget.key} data-widget-key={widget.key}>
                  {widget.type}
                </span>
              ))}
          </div>
        </div>
      );
    }
    render(<Editor />);
    const container = editor.containerRef.current;
    container.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    });
    for (const element of container.querySelectorAll("[data-widget-key]")) {
      const widget = widgets.find(
        (entry) => entry.key === element.dataset.widgetKey
      );
      element.getBoundingClientRect = () => ({
        left: widget.xPosition,
        right: widget.xPosition + 60,
        top: 20,
        bottom: 50,
        width: 60,
        height: 30
      });
    }
    const event = {
      target: container.firstChild,
      currentTarget: container,
      pointerId: 1,
      pointerType: "mouse",
      ctrlKey: true,
      button: 0,
      clientX: 0,
      clientY: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    };
    act(() => editor.selection.handlers.onPointerDownCapture(event));
    act(() =>
      editor.selection.handlers.onPointerUpCapture({
        ...event,
        clientX: 350,
        clientY: 80
      })
    );
    expect(editor.selection.selection.widgets).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(editor.positions[0].pos.map((widget) => widget.key)).toEqual([
      "outside"
    ]);
    act(() => editor.history.undo());
    expect(editor.positions).toEqual(page());
  });
});

it("the new local QA identity cannot bypass authentication in production or on a remote host", () => {
  expect(isLocalQaBuild({ DEV: false, MODE: "local-qa" }, "localhost")).toBe(
    false
  );
  expect(
    isLocalQaBuild({ DEV: true, MODE: "local-qa" }, "sign.example.test")
  ).toBe(false);
  expect(isLocalQaBuild({ DEV: true, MODE: "local-qa" }, "localhost")).toBe(
    true
  );
  const browser = {
    location: { hostname: "localhost" },
    __OPENSIGN_LOCAL_QA_STORAGE_READY__: true,
    sessionStorage: { getItem: () => "enabled" }
  };
  expect(
    isLocalQaIdentityEnabled(browser, { DEV: false, MODE: "local-qa" })
  ).toBe(false);
});
