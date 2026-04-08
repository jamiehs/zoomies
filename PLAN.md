OK, we are going to plan and make a fun JavaScript addon that I can add to another page. Here's what it's going to be:

* It will place one or more sprites on the page. These sprites will be cars, viewed from top-down; we can start with rectangles.
* It'll be an element that takes up the whole page, but can still be placed under/over other parts of the page; maybe `<canvas>` or actual DOM elements.
* I would like the car to drive to wherever I click. The binding for this should be flexible; for instance, I should also be able to programmatically tell the car what coordinates to drive to.
* The cars should drive somewhat realistically; so they should accelerate and decelerate, and brake. They should steer and rotate realistically (mostly from the rear axle).
* The cars should be able to avoid each other or "flock"; so if I had 5 cars and I wanted them to all go to a specific coordinate on the page as the user scrolls, for example... they should not overlap or collide; they should race to the next destination and then come to a stop, or make a stylish skid as they stop.
* The realistic vehicle movement is key here.

Additional Context:
The cars that can drive to specific coordinates are going to live in the margins/blank space of a website about race cars; we want there to be a fun, distracting, dynamic aspect to the page.
