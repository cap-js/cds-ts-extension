using { foo } from '../app/a';

service FooService {
    entity Foo as projection on foo.Foo;
}
