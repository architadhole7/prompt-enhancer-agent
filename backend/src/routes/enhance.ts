import { Router } from "express";
import { enhance } from "../agent/agent";
import { validateInput } from "../agent/validate";

export const enhanceRouter = Router();

enhanceRouter.post("/enhance", async (req, res, next) => {
  try {
    const input = validateInput(req.body); // throws InputError -> 400
    res.json(await enhance(input));
  } catch (err) {
    next(err);
  }
});
