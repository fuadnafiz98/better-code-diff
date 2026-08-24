# sparkline — only with real numbers

Two or more comparable numbers, or none of this.

```
unset   ████████████████████ 180.1s
20000   ██                    20.0s
15000   █                     15.1s
```

- Bars scale to the largest value, 20 characters wide at most.
- The number stays in text beside the bar; a bar alone is decoration.
- One row per measurement, units on every row. Never bar a number you did not
  measure.
