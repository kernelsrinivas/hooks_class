/** use State */

//Syntax
const [state, useState] = useState(initialValue);

//Example
const [count, setCount] = useState(0);

const increaseCount = () => setCount(count + 1);
const decreaseCount = () => setCount(count - 1);

