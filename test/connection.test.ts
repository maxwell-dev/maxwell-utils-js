/* eslint-disable jest/valid-expect-in-promise */
/* eslint-disable jest/no-conditional-expect */
import { AbortablePromise, AbortError } from "@xuchaoqian/abortable-promise";
import { msg_types } from "maxwell-protocol";
import { Connection, Options, TimeoutError, Event } from "../src/index";
import { MultiAltEndpointsConnection } from "../src/connection";

describe("Connection", () => {
  it("normal request", async () => {
    const conn = new Connection("localhost:10000", new Options());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.req_req_t({
        path: "/hello",
        payload: JSON.stringify({}),
        header: {},
      });
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      const result = await request;
      expect(JSON.parse(result.payload)).toEqual("world");
    } catch (reason) {
      console.error(`Error occured: ${reason.stack}`);
    } finally {
      conn.close();
    }
  });

  it("path not exist", async () => {
    const conn = new Connection("localhost:10000", new Options());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.req_req_t({
        path: "/path-not-exist",
        payload: JSON.stringify({}),
        header: {},
      });
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toEqual(
        `code: 299, desc: Failed to get connetion: err: Failed to find endpoint: path: "/path-not-exist"`
      );
    } finally {
      conn.close();
    }
  });

  it("timeout to connect", async () => {
    const conn = new Connection("localhost:1", new Options());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen(1000);
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`Timeout to wait: waiter: 0`);
    } finally {
      conn.close();
    }
  });

  it("timeout to request", async () => {
    const conn = new Connection("localhost:10000", new Options());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`{"ref":1}`);
    } finally {
      conn.close();
    }
  });

  it("failed to encode", async () => {
    const conn = new Connection("localhost:10000", new Options());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = {};
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(AbortError);
      expect(e.message).toEqual(
        `Error: Failed to encode msg: reason: Unknown msg type: function Object() { [native code] }`
      );
    } finally {
      conn.close();
    }
  });

  it("on connected", async () => {
    const conn = new Connection("localhost:10000", new Options());
    expect(conn).toBeInstanceOf(Connection);
    try {
      const ready = new Promise((resolve) => {
        const unListen = conn.addListener(Event.ON_CONNECTED, (conn) => {
          resolve(conn);
          unListen();
        });
      });
      const result = await ready;
      expect(result).toBeInstanceOf(Connection);
    } finally {
      conn.close();
    }
  });

  it("reopen", async () => {
    const conn = new Connection("localhost:10000", new Options());
    expect(conn).toBeInstanceOf(Connection);
    try {
      let count = 0;
      const ready = new Promise((resolve) => {
        conn.addListener(Event.ON_CONNECTED, (conn) => {
          count++;
          conn.reopen();
          conn.reopen();
          conn.reopen();
          console.log("!!!!!!!!!!!!", count);
          if (count == 2) {
            resolve(conn);
          }
        });
      });
      const result = await ready;
      expect(result).toBeInstanceOf(Connection);
      expect(count).toBe(2);
    } finally {
      conn.close();
    }
  }, 10000);
});

describe("MultiAltEndpointsConnection", () => {
  it("normal request", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      new Options()
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      const req = new msg_types.req_req_t({
        path: "/hello",
        payload: JSON.stringify({}),
        header: {},
      });
      await conn.waitOpen();
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      const result = await request;
      expect(JSON.parse(result.payload)).toEqual("world");
    } catch (reason) {
      console.error(`Error occured: ${reason.stack}`);
    } finally {
      conn.close();
    }
  });

  it("timeout to connect", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:1"),
      new Options()
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen(1000);
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`Timeout to wait: waiter: 0`);
    } finally {
      conn.close();
    }
  });

  it("timeout to request", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      new Options()
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen(1000);
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, 2000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`{"ref":1}`);
    } finally {
      conn.close();
    }
  });

  it("on connected", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      new Options()
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      const ready = new Promise((resolve) => {
        const unListen = conn.addListener(Event.ON_CONNECTED, (conn) => {
          resolve(conn);
          unListen();
        });
      });
      const result = await ready;
      expect(result).toBeInstanceOf(MultiAltEndpointsConnection);
    } finally {
      conn.close();
    }
  });

  it("reopen", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      new Options()
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      let count = 0;
      const ready = new Promise((resolve) => {
        conn.addListener(Event.ON_CONNECTED, (conn) => {
          count++;
          conn.reopen();
          conn.reopen();
          conn.reopen();
          if (count == 2) {
            resolve(conn);
          }
        });
      });
      const result = await ready;
      expect(result).toBeInstanceOf(MultiAltEndpointsConnection);
      expect(count).toBe(2);
    } finally {
      conn.close();
    }
  }, 10000);
});
