# API errors

Clients match on the code, never on the message. Codes are never reused or renumbered; a removed error keeps its
row, marked removed.

Every error the API returns for bad input is an `AppError` with an `E4xxx` code; `E5xxx` is for our side. A new
error takes the next free number in its range, in `src/errors/codes.ts` and in the table below.

| code | meaning |
| --- | --- |
| E4001 | an order needs at least one item |
| E4002 | quantity must be a positive whole number |
| E4003 | unknown product |
| E4004 | card number is not valid |
| E4005 | card has expired |
| E4006 | amount must be positive |
| E4007 | currency is not supported |
| E4008 | email address is already registered |
| E4009 | a name is required |
| E4010 | an email address is required |
| E5001 | payment provider unavailable |
| E5002 | storage unavailable |
